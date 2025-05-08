#!/usr/bin/env bun

import { tmpdir } from "os";
import path from "path";
interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
}

interface Socket<T = any> {
  data: T;
  write(data: string | Buffer): void;
}

const enum FramerState {
  WaitingForLength,
  WaitingForMessage,
}

let socketFramerMessageLengthBuffer: Buffer;
export class SocketFramer {
  private state: FramerState = FramerState.WaitingForLength;
  private pendingLength: number = 0;
  private sizeBuffer: Buffer = Buffer.alloc(0);
  private sizeBufferIndex: number = 0;
  private bufferedData: Buffer = Buffer.alloc(0);

  constructor(private onMessage: (message: string) => void) {
    if (!socketFramerMessageLengthBuffer) {
      socketFramerMessageLengthBuffer = Buffer.alloc(4);
    }
    this.reset();
  }

  reset(): void {
    this.state = FramerState.WaitingForLength;
    this.bufferedData = Buffer.alloc(0);
    this.sizeBufferIndex = 0;
    this.sizeBuffer = Buffer.alloc(4);
  }

  send(socket: Socket, data: string): void {
    socketFramerMessageLengthBuffer.writeUInt32BE(Buffer.byteLength(data), 0);
    socket.write(socketFramerMessageLengthBuffer);
    socket.write(data);
  }

  onData(socket: Socket, data: Buffer): void {
    this.bufferedData =
      this.bufferedData.length > 0
        ? Buffer.concat([this.bufferedData, data])
        : data;

    let messagesToDeliver: string[] = [];

    while (this.bufferedData.length > 0) {
      if (this.state === FramerState.WaitingForLength) {
        if (this.sizeBufferIndex + this.bufferedData.length < 4) {
          const remainingBytes = Math.min(
            4 - this.sizeBufferIndex,
            this.bufferedData.length
          );
          this.bufferedData.copy(
            this.sizeBuffer,
            this.sizeBufferIndex,
            0,
            remainingBytes
          );
          this.sizeBufferIndex += remainingBytes;
          this.bufferedData = this.bufferedData.slice(remainingBytes);
          break;
        }

        const remainingBytes = 4 - this.sizeBufferIndex;
        this.bufferedData.copy(
          this.sizeBuffer,
          this.sizeBufferIndex,
          0,
          remainingBytes
        );
        this.pendingLength = this.sizeBuffer.readUInt32BE(0);

        this.state = FramerState.WaitingForMessage;
        this.sizeBufferIndex = 0;
        this.bufferedData = this.bufferedData.slice(remainingBytes);
      }

      if (this.bufferedData.length < this.pendingLength) {
        break;
      }

      const message = this.bufferedData.toString(
        "utf-8",
        0,
        this.pendingLength
      );
      this.bufferedData = this.bufferedData.slice(this.pendingLength);
      this.state = FramerState.WaitingForLength;
      this.pendingLength = 0;
      this.sizeBufferIndex = 0;
      messagesToDeliver.push(message);
    }

    for (const message of messagesToDeliver) {
      this.onMessage(message);
    }
  }
}

export class InspectorSession {
  protected messageCallbacks: Map<number, (result: any) => void>;
  protected eventListeners: Map<string, ((params: any) => void)[]>;
  nextId: number;
  framer?: SocketFramer;
  socket?: Socket<{ onData: (socket: Socket<any>, data: Buffer) => void }>;

  constructor() {
    this.messageCallbacks = new Map();
    this.eventListeners = new Map();
    this.nextId = 1;
  }

  onMessage(data: string) {
    console.log(data);
  }

  send(method: string, params: any = {}) {
    if (!this.framer) throw new Error("Socket not connected");
    const id = this.nextId++;
    const message = { id, method, params };
    this.framer.send(this.socket as any, JSON.stringify(message));
  }

  addEventListener(method: string, callback: (params: any) => void) {
    if (!this.eventListeners.has(method)) {
      this.eventListeners.set(method, []);
    }
    this.eventListeners.get(method)!.push(callback);
  }
}

function randomUnixPath(): string {
  return path.join(tmpdir(), `${Math.random().toString(36).slice(2)}.sock`);
}

var DOMAINS = process.env.BUN_INSPECTOR_DOMAINS?.split(",")!;
if (!DOMAINS?.length) {
  DOMAINS = [
    "Debugger",
    "BunFrontendDevServer",
    "Console",
    "Heap",
    "HTTPServer",
    "Inspector",
    "LifecycleReporter",
    "Runtime",
    "TestReporter",
  ];
}

class Inspector extends InspectorSession {
  constructor() {
    super();
  }

  async enable(): Promise<void> {
    for (let domain of DOMAINS) {
      this.send(domain + ".enable");
    }
  }

  async initialize(): Promise<void> {
    this.send("Inspector.initialized");
  }

  unref() {
    this.socket?.unref();
  }

  ref() {
    this.socket?.ref();
  }
}

async function connect(
  address: string,
  onClose?: () => void
): Promise<Socket<{ onData: (socket: Socket<any>, data: Buffer) => void }>> {
  const { promise, resolve } =
    Promise.withResolvers<
      Socket<{ onData: (socket: Socket<any>, data: Buffer) => void }>
    >();

  var listener = Bun.listen<{
    onData: (socket: Socket<any>, data: Buffer) => void;
  }>({
    unix: address.slice("unix://".length),
    socket: {
      open: (socket) => {
        listener.stop();
        socket.ref();
        resolve(socket);
      },
      data(socket, data: Buffer) {
        socket.data?.onData(socket, data);
      },
      error(socket, error) {
        console.error(error);
      },
      close(socket) {
        if (onClose) {
          onClose();
        }
      },
    },
  });

  return await promise;
}

const url = "unix://" + randomUnixPath();
const socketPromise = connect(url);
const proc = Bun.spawn({
  cmd: [process.execPath, "--inspect-wait=" + url, ...process.argv.slice(2)],
  env: {
    ...process.env,
    BUN_DEBUG_QUIET_LOGS: "1",
  },
});

// Connect to the inspector socket using Unix domain socket
const session = new Inspector();
const socket = await socketPromise;
const framer = new SocketFramer((message: string) => {
  session.onMessage(message);
});
session.socket = socket;
session.framer = framer;
socket.data = {
  onData: framer.onData.bind(framer),
};

await session.enable();
await session.initialize();

const exitCode = await proc.exited;
process.exit(exitCode);
