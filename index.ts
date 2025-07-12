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

// Storage for client errors
interface ClientErrorEntry {
  serverId: number;
  clientErrorPayloadBase64: string;
  timestamp: Date;
}

const clientErrors: ClientErrorEntry[] = [];

// Storage for parsed scripts
interface ParsedScript {
  scriptId: string;
  url?: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  executionContextId?: number;
  hash?: string;
  isContentScript?: boolean;
  isModule?: boolean;
  sourceMapURL?: string;
  hasSourceURL?: boolean;
  length?: number;
}

const parsedScripts: Map<string, ParsedScript> = new Map();

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
      description: "Execute JavaScript expressions within a specific call frame context when the debugger is paused. IMPORTANT: This tool only works when the debugger is paused at a breakpoint or after calling Debugger_pause. First set a breakpoint using Debugger_setBreakpointByUrl or Debugger_setBreakpoint, then when execution pauses, you'll receive a callFrameId in the pause event. Use that callFrameId with this tool to inspect variables, evaluate expressions, and manipulate state in the paused context.",
      inputSchema: {
        callFrameId: z.string().describe("Call frame identifier from the debugger pause event. The debugger must be paused (at a breakpoint or via Debugger_pause) to obtain this ID from the callFrames array in the pause event"),
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

mcp.registerTool(
    "BunFrontendDevServer_getClientErrors",
    {
      title: "Retrieve Bun Frontend Dev Server Client Errors",
      description: "Access client error reports from Bun's Frontend Development Server. This tool captures errors reported by clients via the /_bun/report_error endpoint that have been processed and potentially remapped by the server. Useful for monitoring client-side errors, debugging production issues, and analyzing error patterns. Errors are stored in memory with base64 encoded payloads.",
      inputSchema: {
        limit: z.number().optional().default(100).describe("Maximum number of error entries to retrieve, sorted by newest first (default: 100)"),
        serverId: z.number().optional().describe("Filter errors by specific server instance ID. Useful when running multiple dev servers or after server restarts"),
        decode: z.boolean().optional().default(false).describe("Decode the base64 error payloads to readable format (default: false)"),
      },
    },
  async ({ limit, serverId, decode }) => {
        let errors = [...clientErrors];
        
        // Apply filters
        if (serverId !== undefined) {
          errors = errors.filter(error => error.serverId === serverId);
        }
        
        // Sort by newest first and limit
        errors = errors.slice(-limit).reverse();
        
        // Optionally decode payloads
        const processedErrors = errors.map(error => {
          if (decode) {
            try {
              const decoded = Buffer.from(error.clientErrorPayloadBase64, 'base64').toString('utf-8');
              return {
                ...error,
                decodedPayload: decoded
              };
            } catch (e) {
              return {
                ...error,
                decodedPayload: `Failed to decode: ${e}`
              };
            }
          }
          return error;
        });
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                count: processedErrors.length,
                totalCount: clientErrors.length,
                errors: processedErrors
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_setBreakpoint",
    {
      title: "Set JavaScript Breakpoint",
      description: "Sets a JavaScript breakpoint at a specific location in the code. IMPORTANT: You need to know the scriptId before using this tool. Use Debugger_getScripts to list all available scripts and their IDs, or use Debugger_setBreakpointByUrl if you know the file URL but not the scriptId. The breakpoint will pause execution when the specified line is reached. Supports conditional breakpoints, actions to perform when hit, and auto-continue behavior.",
      inputSchema: {
        scriptId: z.string().describe("Script identifier obtained from Debugger_getScripts tool or Debugger.scriptParsed event. This identifies which script file to set the breakpoint in"),
        lineNumber: z.number().describe("Line number in the script (0-based) where the breakpoint should be set"),
        columnNumber: z.number().optional().describe("Column number in the script (0-based) for more precise breakpoint placement. Optional - if not specified, breakpoint will be at the start of the line"),
        condition: z.string().optional().describe("JavaScript expression to use as breakpoint condition. Debugger will only pause if this evaluates to true (e.g., 'x > 10', 'typeof foo === \"string\"')"),
        autoContinue: z.boolean().optional().default(false).describe("Automatically continue execution after hitting this breakpoint and running any actions. Useful for logging without pausing"),
        actions: z.array(z.object({
          type: z.enum(["log", "evaluate", "sound", "probe"]).describe("Type of action to perform when breakpoint is hit"),
          data: z.string().optional().describe("Data for the action (e.g., message to log for 'log' type, JavaScript to evaluate for 'evaluate' type)"),
        })).optional().describe("Actions to perform when the breakpoint is triggered"),
      },
    },
  async ({ scriptId, lineNumber, columnNumber, condition, autoContinue, actions }) => {
        const location: JSC.Debugger.Location = {
          scriptId,
          lineNumber,
          columnNumber,
        };
        
        const options: JSC.Debugger.BreakpointOptions = {};
        if (condition) options.condition = condition;
        if (autoContinue) options.autoContinue = autoContinue;
        if (actions) options.actions = actions;
        
        const result = await session.sendWithCallback("Debugger.setBreakpoint", {
          location,
          options: Object.keys(options).length > 0 ? options : undefined,
        } satisfies JSC.Debugger.SetBreakpointRequest);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                breakpointId: result.breakpointId,
                actualLocation: result.actualLocation,
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_setBreakpointByUrl",
    {
      title: "Set Breakpoint by URL",
      description: "Sets JavaScript breakpoint at given location specified by URL or URL regex pattern. This is the PREFERRED METHOD when you don't have the scriptId - you can set breakpoints using just the file path without needing to call Debugger_getScripts first. The breakpoint will persist across page reloads and apply to all matching scripts. Use this instead of Debugger_setBreakpoint when you know the file name/path.",
      inputSchema: {
        lineNumber: z.number().describe("Line number (0-based) to set breakpoint at in the matching file(s)"),
        url: z.string().optional().describe("Exact URL of the resource to set breakpoint on (e.g., 'file:///path/to/script.js', 'http://localhost:3000/app.js')"),
        urlRegex: z.string().optional().describe("Regex pattern for URLs to set breakpoints on (e.g., '.*\\.js$' for all JS files, '.*/components/.*' for files in components folder). Either url or urlRegex must be specified"),
        columnNumber: z.number().optional().describe("Column offset (0-based) in the line to set breakpoint at. Optional - if not specified, breakpoint will be at the start of the line"),
        condition: z.string().optional().describe("JavaScript expression to use as breakpoint condition. Debugger will only pause if this evaluates to true"),
        autoContinue: z.boolean().optional().default(false).describe("Automatically continue execution after hitting this breakpoint and running any actions"),
      },
    },
  async ({ lineNumber, url, urlRegex, columnNumber, condition, autoContinue }) => {
        if (!url && !urlRegex) {
          throw new Error("Either 'url' or 'urlRegex' must be specified");
        }
        
        const options: JSC.Debugger.BreakpointOptions = {};
        if (condition) options.condition = condition;
        if (autoContinue) options.autoContinue = autoContinue;
        
        const result = await session.sendWithCallback("Debugger.setBreakpointByUrl", {
          lineNumber,
          url,
          urlRegex,
          columnNumber,
          options: Object.keys(options).length > 0 ? options : undefined,
        } satisfies JSC.Debugger.SetBreakpointByUrlRequest);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                breakpointId: result.breakpointId,
                locations: result.locations,
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_removeBreakpoint",
    {
      title: "Remove Breakpoint",
      description: "Removes a previously set JavaScript breakpoint using its identifier. Use this to clean up breakpoints that are no longer needed.",
      inputSchema: {
        breakpointId: z.string().describe("Breakpoint identifier returned by setBreakpoint or setBreakpointByUrl when the breakpoint was created"),
      },
    },
  async ({ breakpointId }) => {
        await session.sendWithCallback("Debugger.removeBreakpoint", {
          breakpointId,
        } satisfies JSC.Debugger.RemoveBreakpointRequest);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: `Breakpoint ${breakpointId} removed successfully`,
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_pause",
    {
      title: "Pause JavaScript Execution",
      description: "Pauses JavaScript execution at the next available opportunity. This will suspend the debuggee and allow you to inspect the current state, evaluate expressions, and step through code. The debugger will emit a 'paused' event when execution stops.",
      inputSchema: {},
    },
  async () => {
        await session.sendWithCallback("Debugger.pause", {} satisfies JSC.Debugger.PauseRequest);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "JavaScript execution paused. Use 'resume' or step commands to continue.",
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_resume",
    {
      title: "Resume JavaScript Execution",
      description: "Resumes JavaScript execution after being paused at a breakpoint or by a pause command. Execution will continue until the next breakpoint, exception, or pause command is encountered.",
      inputSchema: {},
    },
  async () => {
        await session.sendWithCallback("Debugger.resume", {} satisfies JSC.Debugger.ResumeRequest);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "JavaScript execution resumed",
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_stepInto",
    {
      title: "Step Into Function",
      description: "Steps into the next function call when paused. If the next statement is a function call, execution will pause at the first line inside that function. If not a function call, behaves like stepOver.",
      inputSchema: {},
    },
  async () => {
        await session.sendWithCallback("Debugger.stepInto", {} satisfies JSC.Debugger.StepIntoRequest);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "Stepped into next function call",
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_stepOut",
    {
      title: "Step Out of Function",
      description: "Steps out of the current function when paused. Execution will continue until the current function returns, then pause at the next statement after the function call in the calling function.",
      inputSchema: {},
    },
  async () => {
        await session.sendWithCallback("Debugger.stepOut", {} satisfies JSC.Debugger.StepOutRequest);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "Stepped out of current function",
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_stepOver",
    {
      title: "Step Over Statement",
      description: "Steps over the next statement when paused. If the next statement is a function call, the entire function will execute and pause at the next statement after the call. Otherwise, execution pauses at the next statement in the current function.",
      inputSchema: {},
    },
  async () => {
        await session.sendWithCallback("Debugger.stepOver", {} satisfies JSC.Debugger.StepOverRequest);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                message: "Stepped over to next statement",
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_getScripts",
    {
      title: "List Parsed Scripts",
      description: "Lists all JavaScript files that have been parsed by the debugger. This shows available scripts with their IDs, URLs, and locations. Use the scriptId from this list when setting breakpoints or getting script source.",
      inputSchema: {
        filter: z.string().optional().describe("Optional filter to search scripts by URL or scriptId"),
      },
    },
  async ({ filter }) => {
        let scripts = Array.from(parsedScripts.values());
        
        // Apply filter if provided
        if (filter) {
          const filterLower = filter.toLowerCase();
          scripts = scripts.filter(script => 
            script.scriptId.toLowerCase().includes(filterLower) ||
            (script.url && script.url.toLowerCase().includes(filterLower))
          );
        }
        
        // Sort by URL for better readability
        scripts.sort((a, b) => {
          if (!a.url && !b.url) return 0;
          if (!a.url) return 1;
          if (!b.url) return -1;
          return a.url.localeCompare(b.url);
        });
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                count: scripts.length,
                totalCount: parsedScripts.size,
                scripts: scripts.map(script => ({
                  scriptId: script.scriptId,
                  url: script.url || "<anonymous>",
                  lines: `${script.startLine}-${script.endLine}`,
                  isModule: script.isModule,
                  hasSourceMap: !!script.sourceMapURL,
                  executionContextId: script.executionContextId
                }))
              }, null, 2)
            },
          ],
        };
  }
)

mcp.registerTool(
    "Debugger_getScriptSource",
    {
      title: "Get Script Source Code",
      description: "Retrieves the source code of a specific JavaScript file by its scriptId. First use Debugger_getScripts to find the scriptId of the file you want to inspect. This tool is helpful for viewing the actual code content to determine exact line numbers for setting breakpoints or understanding the code structure.",
      inputSchema: {
        scriptId: z.string().describe("Script identifier obtained from Debugger_getScripts tool. Use that tool first to list available scripts and their IDs"),
      },
    },
  async ({ scriptId }) => {
        const result = await session.sendWithCallback("Debugger.getScriptSource", {
          scriptId,
        } satisfies JSC.Debugger.GetScriptSourceRequest);
        
        const scriptInfo = parsedScripts.get(scriptId);
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                scriptId,
                url: scriptInfo?.url || "<unknown>",
                source: result.scriptSource,
                bytecode: result.bytecode
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

// Add event listener for client errors
session.addEventListener("BunFrontendDevServer.clientErrorReported", (params: JSC.BunFrontendDevServer.ClientErrorReportedEvent) => {
  clientErrors.push({
    serverId: params.serverId,
    clientErrorPayloadBase64: params.clientErrorPayloadBase64,
    timestamp: new Date()
  });
});

// Add event listener for debugger paused events
session.addEventListener("Debugger.paused", (params: JSC.Debugger.PausedEvent) => {
  console.log("Debugger paused:", {
    reason: params.reason,
    callFrames: params.callFrames.map(frame => ({
      functionName: frame.functionName || "<anonymous>",
      location: `${frame.url || frame.scriptId}:${frame.location.lineNumber}:${frame.location.columnNumber || 0}`,
      scopeChain: frame.scopeChain.length
    })),
    data: params.data
  });
});

// Add event listener for debugger resumed events
session.addEventListener("Debugger.resumed", () => {
  console.log("Debugger resumed");
});

// Add event listener for script parsed events (useful for debugging)
session.addEventListener("Debugger.scriptParsed", (params: JSC.Debugger.ScriptParsedEvent) => {
  // Store parsed script information
  const scriptInfo: ParsedScript = {
    scriptId: params.scriptId,
    url: params.url,
    startLine: params.startLine,
    startColumn: params.startColumn,
    endLine: params.endLine,
    endColumn: params.endColumn,
    executionContextId: params.executionContextId,
    hash: params.hash,
    isContentScript: params.isContentScript,
    isModule: params.isModule,
    sourceMapURL: params.sourceMapURL,
    hasSourceURL: params.hasSourceURL,
    length: params.length
  };
  
  parsedScripts.set(params.scriptId, scriptInfo);
  
  console.log("Script parsed:", {
    scriptId: params.scriptId,
    url: params.url || "<anonymous>",
    startLine: params.startLine,
    startColumn: params.startColumn,
    endLine: params.endLine,
    endColumn: params.endColumn,
    executionContextId: params.executionContextId,
    hash: params.hash,
    isModule: params.isModule
  });
});

const port = 4000;
console.log(`MCP server listening on http://localhost:${port}/mcp`);

Bun.serve({
  fetch: app.fetch,
  port,
})
