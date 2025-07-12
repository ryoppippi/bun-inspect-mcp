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
  name: `Bun Inspector Protocol MCP Server`,
  version: `${Bun.version}-inspector`,
  description: `MCP server providing direct access to Bun's Chrome DevTools Protocol inspector. Enables runtime JavaScript evaluation, debugger integration, and console log monitoring for Bun processes. Automatically spawns Bun with inspector enabled and provides tools for real-time debugging and application introspection.`
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
      title: "Evaluate JavaScript in Bun Runtime",
      description: "Execute JavaScript expressions in the Bun runtime context and retrieve results. This tool connects to Bun's inspector protocol to evaluate code in real-time, useful for debugging, testing expressions, inspecting variables, and interacting with the running application state. Results can be returned by value (serialized) or by reference (for complex objects).",
      inputSchema: {
        expression: z.string().min(1).describe("JavaScript code to evaluate (e.g., 'console.log(\"test\")', 'process.version', 'Math.PI * 2', 'document.querySelector(\".btn\")')"),
        returnByValue: z.boolean().optional().default(true).describe("Return result by value (true) for primitive types and serializable objects, or by reference (false) for complex objects that need further inspection"),
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
      title: "Evaluate Code on Debugger Call Frame",
      description: "Execute JavaScript expressions within a specific call frame context when the debugger is paused. This powerful debugging tool allows you to inspect and manipulate variables, call functions, and evaluate expressions in the exact scope where execution is paused. Essential for debugging breakpoints, examining local variables, testing fixes, and understanding program state at specific execution points.",
      inputSchema: {
        callFrameId: z.string().describe("Call frame identifier from the debugger pause stack (obtained from Debugger.paused event). Each frame represents a function call in the stack trace"),
        expression: z.string().min(1).describe("JavaScript code to evaluate within the call frame's scope (e.g., 'localVariable', 'this.property', 'myFunction()', 'arguments[0]')"),
        returnByValue: z.boolean().optional().default(true).describe("Return primitive values and serializable objects directly (true) or return complex objects as remote object references (false)"),
        generatePreview: z.boolean().optional().default(true).describe("Generate a preview for object results, showing property names and values for easier inspection"),
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
      title: "Retrieve Bun Frontend Dev Server Console Logs",
      description: "Access and filter console log messages from Bun's Frontend Development Server. This tool captures all console outputs (log, warn, error, debug) from your frontend application running in Bun's dev server environment. Useful for monitoring application behavior, debugging issues, tracking errors, and analyzing runtime logs without direct console access. Logs are stored in memory and can be filtered by server instance, log type, or retrieved in batches.",
      inputSchema: {
        limit: z.number().optional().default(100).describe("Maximum number of log entries to retrieve, sorted by newest first (default: 100). Use smaller values for quick checks or larger values for comprehensive log analysis"),
        serverId: z.number().optional().describe("Filter logs by specific server instance ID. Useful when running multiple dev servers or after server restarts"),
        kind: z.string().optional().describe("Filter logs by type/kind (e.g., 'log', 'error', 'warn', 'debug'). Leave empty to retrieve all log types"),
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
