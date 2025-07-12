#!/usr/bin/env bun

import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { z } from "zod/v3";
import { remoteObjectToString } from "./preview";
import type { JSC } from './types.ts'

interface Message {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
}

interface Socket<T = any> {
  data: T;
  write(data: string | Buffer): void;
  unref?(): void;
  ref?(): void;
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
    try {
      const message = JSON.parse(data);
      if (message.id && this.messageCallbacks.has(message.id)) {
        const callback = this.messageCallbacks.get(message.id);
        callback!(message);
      } else if (message.method && !message.id) {
        // This is an event, not a response
        const listeners = this.eventListeners.get(message.method);
        if (listeners) {
          for (const listener of listeners) {
            listener(message.params);
          }
        }
      }
    } catch (e) {
      console.error("Failed to parse message:", e);
    }
  }

  send(method: string, params: any = {}) {
    if (!this.framer) throw new Error("Socket not connected");
    const id = this.nextId++;
    const message = { id, method, params };
    this.framer.send(this.socket as any, JSON.stringify(message));
  }

  sendWithCallback(method: string, params: any = {}): Promise<any> {
    if (!this.framer) throw new Error("Socket not connected");
    const id = this.nextId++;
    
    return new Promise((resolve) => {
      this.messageCallbacks.set(id, ({ result }) => {
        this.messageCallbacks.delete(id);
        resolve(result);
      });
      
      const message = { id, method, params };
      this.framer!.send(this.socket as any, JSON.stringify(message));
    });
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

const mcp = new McpServer({
  name: `mcp server for bun inspector`,
  version: Bun.version,
})

// Storage for console logs
interface ConsoleLogEntry {
  serverId: number;
  kind: string;
  message: string;
  timestamp: Date;
}

const consoleLogs: ConsoleLogEntry[] = [];

mcp.registerTool(
    "Runtime_evaluate",
    {
      title: "runtime evaluate",
      description: "Evaluate JavaScript code in BUN runtime",
      inputSchema: {
        expression: z.string().min(1).describe("JavaScript code to evaluate"),
        returnByValue: z.boolean().optional().default(true).describe("Return result by value instead of reference"),
      },
    },
  async ({ expression , returnByValue}) => {
        const result = await session.sendWithCallback("Runtime.evaluate", {
          expression,
          returnByValue: returnByValue,
        } satisfies JSC.Runtime.EvaluateRequest);
        const resultString = remoteObjectToString(result.result, true);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                ...result,
                resultString,
              })
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_evaluateOnCallFrame",
    {
      title: "debugger evaluate on call frame",
      description: "Evaluate JavaScript code on a specific call frame (for debugging paused code)",
      inputSchema: {
        callFrameId: z.string().describe("Call frame identifier to evaluate expression on"),
        expression: z.string().min(1).describe("JavaScript code to evaluate in the context of the call frame"),
        returnByValue: z.boolean().optional().default(true).describe("Return result by value instead of reference"),
        generatePreview: z.boolean().optional().default(true).describe("Whether preview should be generated for the result"),
      },
    },
  async ({ callFrameId, expression, returnByValue, generatePreview  }) => {
        const result = await session.sendWithCallback("Debugger.evaluateOnCallFrame", {
          callFrameId,
          expression,
          returnByValue,
          generatePreview,
        } satisfies JSC.Debugger.EvaluateOnCallFrameRequest)
        
        if (result.result) {
          const resultString = remoteObjectToString(result.result, true);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  ...result,
                  resultString,
                })
              },
            ],
          };
        } else if (result.exceptionDetails) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Exception occurred during evaluation",
                  exceptionDetails: result.exceptionDetails,
                })
              },
            ],
          };
        }
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(result)
            },
          ],
        };
  }
)

mcp.registerTool(
    "BunFrontendDevServer_getConsoleLogs",
    {
      title: "Get console logs on Frontend Dev Server",
      description: "Retrieve console log messages from the Frontend Dev Server in Bun",
      inputSchema: {
        limit: z.number().optional().default(100).describe("Maximum number of logs to return (newest first)"),
        serverId: z.number().optional().describe("Filter logs by server ID"),
        kind: z.string().optional().describe("Filter logs by kind/type"),
      },
    },
  async ({ limit, serverId, kind }) => {
        let logs = [...consoleLogs];
        
        // Apply filters
        if (serverId !== undefined) {
          logs = logs.filter(log => log.serverId === serverId);
        }
        if (kind !== undefined) {
          logs = logs.filter(log => log.kind === kind);
        }
        
        // Sort by newest first and limit
        logs = logs.slice(-limit).reverse();
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                count: logs.length,
                totalCount: consoleLogs.length,
                logs: logs
              }, null, 2)
            },
          ],
        };
  }
)

const app = new Hono();
app.all("/mcp", async c => {
  const transport = new StreamableHTTPTransport();
  await mcp.connect(transport);
  return transport.handleRequest(c);
});


const url = "unix://" + randomUnixPath();
const socketPromise = connect(url);
const proc = Bun.spawn({
  cmd: [process.execPath, "--inspect-wait=" + url, ...process.argv.slice(2)],
  env: {
    ...process.env,
    BUN_DEBUG_QUIET_LOGS: "1",
  },
});

proc.exited.then(
  (exitCode) => {
    setTimeout(() => {
      process.exit(exitCode);
    }, 1);
  },
  (error) => {
    console.error(error);
    process.exit(1);
  }
);

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
session.unref();

// Add event listener for console logs
session.addEventListener("BunFrontendDevServer.consoleLog", (params: JSC.BunFrontendDevServer.ConsoleLogEvent) => {
  consoleLogs.push({
    serverId: params.serverId,
    kind: params.kind,
    message: params.message,
    timestamp: new Date()
  });
});

const port = 4000;
console.log(`MCP server listening on http://localhost:${port}/mcp`);

Bun.serve({
  fetch: app.fetch,
  port,
})
