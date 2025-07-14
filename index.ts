#!/usr/bin/env bun

import type { JSC } from './types.ts'
import type { ServerWebSocket } from 'bun'
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { StreamableHTTPTransport } from "@hono/mcp";
import { createBunWebSocket } from 'hono/bun'
import { z } from "zod/v3";
import { createBirpc } from "birpc";
import { remoteObjectToString } from "./preview";

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
    this.socket?.unref?.();
  }

  ref() {
    this.socket?.ref?.();
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

// Storage for backend console messages
interface BackendConsoleMessage {
  source: string;
  level: "log" | "info" | "warning" | "error" | "debug";
  text: string;
  type?: string;
  timestamp: Date;
  stackTrace?: any;
  line?: number;
  column?: number;
  url?: string;
}
const backendConsoleLogs: BackendConsoleMessage[] = [];

// Browser control types
interface BrowserConnection {
  id: string;
  ws: any;
  rpc: any;
  url: string;
  connected: boolean;
}

// Active browser connections
const browserConnections = new Map<string, BrowserConnection>();

// Browser RPC functions that MCP can call
interface BrowserFunctions {
  findElement: (params: { type: string; value: string; tagName?: string }) => Promise<any>;
  clickElement: (params: { type: string; value: string; tagName?: string; options?: any }) => Promise<any>;
  inputText: (params: { type: string; value: string; tagName?: string; text: string; clear?: boolean }) => Promise<any>;
  evaluate: (params: { expression: string }) => Promise<any>;
  getElements: (params: { selector: string; limit?: number }) => Promise<any>;
  waitForElement: (params: { type: string; value: string; tagName?: string; timeout?: number }) => Promise<any>;
  getPageInfo: () => Promise<any>;
}

// Create server functions for a specific connection
const createServerFunctions = (connectionId: string) => ({
  notifyEvent: async ({ type, data }: { type: string; data: any }) => {
    console.log(`[Browser Event] notifyEvent called for ${connectionId}`);
    console.log(`[Browser Event] ${type}:`, data);
    
    // Update connection info when browser connects
    if (type === 'connected' && data.url) {
      const connection = browserConnections.get(connectionId);
      if (connection) {
        connection.url = data.url;
        console.log(`[Browser Event] Updated URL for ${connectionId}: ${data.url}`);
      }
    }
    
    // Return success
    return { success: true, message: `Event ${type} received` };
  },
  reportError: async ({ error, stack }: { error: string; stack?: string }) => {
    console.error(`[Browser Error] reportError called for ${connectionId}`);
    console.error(`[Browser Error] from ${connectionId}:`, error, stack);
    
    // Return acknowledgment
    return { success: true, message: 'Error reported' };
  },
});

mcp.registerTool(
    "Runtime_evaluate",
    {
      title: "Evaluate JavaScript in Bun Runtime",
      description: "Execute JavaScript expressions in the Bun runtime context and retrieve results. This powerful tool connects directly to Bun's V8 Inspector Protocol to evaluate any JavaScript code in real-time within the running application's global scope. Perfect for debugging, testing expressions, inspecting global variables, modifying application state, and performing runtime diagnostics. Supports both synchronous and asynchronous code execution, with results returned either by value (fully serialized for primitives and simple objects) or by reference (for complex objects requiring further inspection). Can access all global objects including process, global, console, and any application-specific globals.",
      inputSchema: {
        expression: z.string().min(1).describe("JavaScript code to evaluate in the global scope. Examples: 'console.log(\"test\")', 'process.version', 'Math.PI * 2', 'document.querySelector(\".btn\")', 'await fetch(\"/api/data\")', 'Object.keys(global)', '[...new Set([1,2,3])]', 'new Promise(r => setTimeout(() => r(\"done\"), 1000))'"),
        returnByValue: z.boolean().optional().default(true).describe("Return result by value (true) for primitive types and serializable objects, or by reference (false) for complex objects that need further inspection. When false, returns a RemoteObject reference that can be used with other debugger commands"),
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
      description: "Execute JavaScript expressions within a specific call frame's scope when the debugger is paused - the most powerful tool for runtime inspection. Unlike Runtime_evaluate which only sees global scope, this tool executes code in the exact context where execution is paused, with full access to local variables, function parameters, this binding, closure variables, and the complete scope chain. PREREQUISITE: Debugger must be paused (via breakpoint or Debugger_pause) to get callFrameId from the pause event. Perfect for inspecting local state, modifying variables during debugging, calling local functions, exploring object properties, checking closure values, and understanding scope inheritance. Supports any valid JavaScript including property access, method calls, and even variable assignments for testing fixes.",
      inputSchema: {
        callFrameId: z.string().describe("Call frame identifier from the debugger pause event. The debugger must be paused (at a breakpoint or via Debugger_pause) to obtain this ID from the callFrames array in the pause event"),
        expression: z.string().min(1).describe("JavaScript code to evaluate within the call frame's scope. Has access to all local variables, parameters, this, and closure scope. Examples: 'localVariable', 'this.property', 'myFunction()', 'arguments[0]', 'localVar = 42', 'JSON.stringify(complexObject, null, 2)', 'Object.keys(this)'"),
        returnByValue: z.boolean().optional().default(true).describe("Return primitive values and serializable objects directly (true) or return complex objects as remote object references (false) for further inspection"),
        generatePreview: z.boolean().optional().default(true).describe("Generate a preview for object results, showing property names and values for easier inspection without full serialization"),
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
      description: "Access and filter console log messages from Bun's Frontend Development Server, capturing all client-side console outputs from your frontend application. This specialized tool monitors console.log, console.warn, console.error, and console.debug calls from browser/client code running through Bun's dev server. Essential for debugging frontend issues without browser DevTools access, monitoring client-side errors in CI/CD, tracking user interactions and events, analyzing performance logs, and debugging issues that only occur in specific environments. Logs are stored in memory with timestamps and can be filtered by server instance (for multiple dev servers), log type/severity, or retrieved in configurable batches. Note: This captures FRONTEND logs - for backend/server logs, use Console_getBackendLogs.",
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
      description: "Access detailed client-side error reports from Bun's Frontend Development Server error reporting system. This tool captures JavaScript errors, unhandled promise rejections, and runtime exceptions reported by frontend clients via the /_bun/report_error endpoint. Each error is processed by the dev server (including source map remapping for accurate stack traces) and stored with full context. Perfect for monitoring production frontend stability, debugging client-specific issues, analyzing error patterns and frequency, tracking down elusive browser-specific bugs, and understanding error impact. Errors include full stack traces, error messages, browser info, and timestamps. The base64 encoded payloads can be decoded to reveal complete error details including source positions and user agent data.",
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
      description: "Sets a precise JavaScript breakpoint at a specific location using script ID and line number. This advanced debugging tool requires knowing the scriptId beforehand (use Debugger_getScripts to discover script IDs). Breakpoints are the foundation of interactive debugging - when execution reaches the specified line, the entire JavaScript runtime pauses, allowing full inspection of program state. Supports powerful features like conditional breakpoints (only pause when conditions are met), automated actions (log values without pausing), and auto-continue mode for non-intrusive debugging. Perfect for debugging specific functions, catching edge cases with conditions, logging values in production without code changes, and understanding complex control flow. Works only on backend/server-side code executed by Bun.",
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
      description: "Sets JavaScript breakpoints using file paths or URL patterns - the RECOMMENDED approach for debugging. This tool eliminates the need to find script IDs, allowing you to set breakpoints directly using familiar file paths (e.g., 'file:///path/to/app.js') or URL patterns. Breakpoints persist across reloads and automatically apply to all scripts matching your pattern. Supports powerful regex patterns for setting breakpoints across multiple files (e.g., '.*\.test\.js$' for all test files). Like setBreakpoint, supports conditional breakpoints, auto-continue, and actions. Perfect for debugging before scripts load, setting breakpoints in dynamic imports, debugging across multiple similar files, and working with familiar file paths. Works only on backend/server-side code. This is the preferred method over Debugger_setBreakpoint.",
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
      description: "Removes a previously set JavaScript breakpoint using its unique identifier. Essential for breakpoint management during debugging sessions - cleans up breakpoints that are no longer needed, prevents unwanted pauses in production code, and helps maintain a clean debugging environment. The breakpointId is returned when creating breakpoints with setBreakpoint or setBreakpointByUrl. Removing breakpoints is important for performance (each active breakpoint has overhead) and avoiding confusion from forgotten breakpoints. Works with all breakpoint types including conditional breakpoints and those with actions. Once removed, the breakpoint cannot be restored - you must create a new one.",
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
      description: "Immediately pauses JavaScript execution at the next available statement, effectively creating a runtime breakpoint. This powerful debugging tool suspends the entire JavaScript runtime, allowing you to inspect the current execution state, examine call stacks, evaluate expressions in the current scope, and step through code line by line. When paused, you gain access to all local variables, closure scopes, and the complete call stack. The debugger will emit a 'Debugger.paused' event containing the full call stack with callFrameIds that can be used with Debugger_evaluateOnCallFrame. Essential for debugging complex async flows, promise chains, event handlers, and understanding runtime behavior. Works seamlessly with all other debugger tools.",
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
      description: "Resumes normal JavaScript execution after being paused at a breakpoint, manual pause, or exception. This command releases the debugger's hold on the runtime, allowing code to continue executing at full speed until the next breakpoint, uncaught exception, or manual pause is encountered. Essential for continuing program flow after inspection or modification of state. When resumed, all pending asynchronous operations, timers, and event handlers will continue processing. The debugger will emit a 'Debugger.resumed' event to confirm execution has continued. Must be called when debugger is in paused state - check console for pause events.",
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
      description: "Steps into the next function call when the debugger is paused, allowing deep inspection of function implementations. If the next statement contains a function call, execution will pause at the first executable line inside that function, giving you access to function parameters, local scope, and the ability to trace through the function's logic. Perfect for understanding how libraries work, debugging nested function calls, tracing through callbacks, and investigating method implementations. If the next statement is not a function call, behaves identically to stepOver. Works with all function types including arrow functions, async functions, generators, and class methods. Requires debugger to be in paused state.",
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
      description: "Steps out of the current function to return to the calling context when debugger is paused. Execution continues through the remainder of the current function (including any finally blocks) until it returns, then pauses at the next statement after the function call in the parent scope. Invaluable for quickly exiting deeply nested functions, finishing inspection of a function you've stepped into, returning from recursive calls, or skipping remaining function logic you're not interested in. The return value (if any) will be available for inspection in the parent scope. Works with all function types including async functions (waits for promise resolution), generators (runs to completion or yield), and arrow functions. Requires debugger to be in paused state within a function call.",
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
      description: "Steps over the next statement when debugger is paused, executing it completely before pausing again. If the next statement is a function call, the entire function executes (including any nested calls) and the debugger pauses at the statement following the call, allowing you to skip function internals you're not interested in debugging. For non-function statements (assignments, loops, conditionals), execution advances by one statement. Perfect for quickly moving through code while staying at the current scope level, executing utility functions without diving into them, and focusing on high-level program flow. Works with all statement types including await expressions (waits for promise), loop iterations, and conditional branches. Requires debugger to be in paused state.",
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
    "Browser_list",
    {
      title: "List Browser Connections",
      description: "Lists all browser connections (active and pending). Shows connection status, browser IDs, and page URLs. Use this before Browser_connect to see if a browser is already connected or to find available browser IDs.",
      inputSchema: {},
    },
    async () => {
      const connections = Array.from(browserConnections.entries()).map(([id, conn]) => ({
        browserId: id,
        connected: conn.connected,
        url: conn.url || "Not connected yet",
        status: conn.connected ? "Connected" : "Waiting for connection"
      }));
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              totalConnections: connections.length,
              connections: connections
            }, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Browser_connect",
    {
      title: "Connect to Browser for Control",
      description: "Establishes a WebSocket connection to a browser that has loaded the browser-control.js script. This enables remote control of browser elements, JavaScript evaluation, and DOM manipulation. The browser must have the control script loaded first (either via script tag or console). Once connected, you can click elements, input text, evaluate JavaScript, and monitor page state. The connection persists until explicitly disconnected or the browser closes. TIP: Use Browser_list first to check existing connections.",
      inputSchema: {
        browserId: z.string().describe("Unique identifier for this browser connection. Use this ID to reference the connection in other browser control commands"),
        waitForConnection: z.boolean().optional().default(true).describe("Wait for browser to connect (true) or return immediately (false). When true, waits up to 10 seconds for connection")
      },
    },
    async ({ browserId, waitForConnection }) => {
      // Check if already connected
      if (browserConnections.has(browserId)) {
        const conn = browserConnections.get(browserId)!;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                connected: conn.connected,
                browserId,
                url: conn.url,
                message: "Already connected to this browser"
              }, null, 2)
            },
          ],
        };
      }
      
      // Create connection placeholder
      const connection: BrowserConnection = {
        id: browserId,
        ws: null,
        rpc: null,
        url: "",
        connected: false
      };
      browserConnections.set(browserId, connection);
      
      if (waitForConnection) {
        // Wait for connection (up to 10 seconds)
        const startTime = Date.now();
        while (Date.now() - startTime < 10000) {
          if (connection.connected) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify({
                    connected: true,
                    browserId,
                    url: connection.url,
                    message: "Successfully connected to browser"
                  }, null, 2)
                },
              ],
            };
          }
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        // Timeout
        browserConnections.delete(browserId);
        throw new Error("Timeout waiting for browser connection. Make sure the browser has loaded the control script.");
      }
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              connected: false,
              browserId,
              message: "Browser connection initialized. Waiting for browser to connect...",
              instructions: "Load the browser-control.js script in your browser to establish connection"
            }, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Browser_click",
    {
      title: "Click Element in Browser",
      description: "Clicks an element in the connected browser using various selector types. Supports finding elements by ID, text content, CSS selector, or XPath. Can specify click coordinates and other mouse event options. The browser must be connected via Browser_connect first. Perfect for automating user interactions, testing UI flows, and triggering events.",
      inputSchema: {
        browserId: z.string().describe("Browser connection ID from Browser_connect"),
        selector: z.object({
          type: z.enum(["id", "text", "css", "xpath"]).describe("Type of selector to use"),
          value: z.string().describe("Selector value (e.g., 'submit-button' for ID, 'Submit' for text, '.btn-primary' for CSS)"),
          tagName: z.string().optional().describe("Optional tag name filter when using text selector (e.g., 'button', 'a')")
        }).describe("Element selector specification"),
        options: z.object({
          x: z.number().optional().describe("X coordinate for click (relative to element)"),
          y: z.number().optional().describe("Y coordinate for click (relative to element)"),
          button: z.number().optional().describe("Mouse button (0=left, 1=middle, 2=right)"),
          ctrlKey: z.boolean().optional().describe("Hold Ctrl key during click"),
          shiftKey: z.boolean().optional().describe("Hold Shift key during click"),
          altKey: z.boolean().optional().describe("Hold Alt key during click"),
          metaKey: z.boolean().optional().describe("Hold Meta/Cmd key during click")
        }).optional().describe("Click event options")
      },
    },
    async ({ browserId, selector, options }) => {
      const connection = browserConnections.get(browserId);
      if (!connection || !connection.connected) {
        throw new Error(`Browser ${browserId} is not connected. Use Browser_connect first.`);
      }
      
      // Create a timeout promise that resolves after 1 second
      const timeoutPromise = new Promise<string>((resolve) => 
        setTimeout(() => resolve("ok"), 1000)
      );
      
      // Race between the RPC call and timeout
      const result = await Promise.race([
        connection.rpc.clickElement({
          type: selector.type,
          value: selector.value,
          tagName: selector.tagName,
          options
        }).then(() => "ok"),
        timeoutPromise
      ]);
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Browser_input",
    {
      title: "Input Text in Browser Element",
      description: "Types text into an input field, textarea, or contenteditable element in the connected browser. Automatically focuses the element, can clear existing content, and triggers appropriate input/change events. Supports all standard form inputs and rich text editors. The browser must be connected via Browser_connect first.",
      inputSchema: {
        browserId: z.string().describe("Browser connection ID from Browser_connect"),
        selector: z.object({
          type: z.enum(["id", "text", "css", "xpath"]).describe("Type of selector to use"),
          value: z.string().describe("Selector value"),
          tagName: z.string().optional().describe("Optional tag name filter when using text selector")
        }).describe("Element selector specification"),
        text: z.string().describe("Text to input into the element"),
        clear: z.boolean().optional().default(true).describe("Clear existing content before typing (default: true)")
      },
    },
    async ({ browserId, selector, text, clear }) => {
      const connection = browserConnections.get(browserId);
      if (!connection || !connection.connected) {
        throw new Error(`Browser ${browserId} is not connected. Use Browser_connect first.`);
      }
      
      // Create a timeout promise that resolves after 1 second
      const timeoutPromise = new Promise<string>((resolve) => 
        setTimeout(() => resolve("ok"), 1000)
      );
      
      // Race between the RPC call and timeout
      const result = await Promise.race([
        connection.rpc.inputText({
          type: selector.type,
          value: selector.value,
          tagName: selector.tagName,
          text,
          clear
        }).then(() => "ok"),
        timeoutPromise
      ]);
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Browser_evaluate",
    {
      title: "Evaluate JavaScript in Browser",
      description: "Executes arbitrary JavaScript code in the connected browser's context with full access to the DOM, window object, and all browser APIs. Returns the evaluation result. Can be used for complex automation, data extraction, or any custom browser manipulation. The browser must be connected via Browser_connect first. Use with caution as it has full access to the page.",
      inputSchema: {
        browserId: z.string().describe("Browser connection ID from Browser_connect"),
        expression: z.string().describe("JavaScript expression to evaluate in browser context. Has full access to document, window, and all browser APIs")
      },
    },
    async ({ browserId, expression }) => {
      const connection = browserConnections.get(browserId);
      if (!connection || !connection.connected) {
        throw new Error(`Browser ${browserId} is not connected. Use Browser_connect first.`);
      }
      
      const result = await connection.rpc.evaluate({ expression });
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Browser_getElements",
    {
      title: "Query Elements in Browser",
      description: "Queries the DOM for elements matching a CSS selector and returns detailed information about each match including attributes, text content, position, and size. Useful for inspecting page structure, verifying element presence, or gathering data from multiple elements. The browser must be connected via Browser_connect first.",
      inputSchema: {
        browserId: z.string().describe("Browser connection ID from Browser_connect"),
        selector: z.string().describe("CSS selector to query elements (e.g., '.btn', '#header', 'input[type=email]')"),
        limit: z.number().optional().default(10).describe("Maximum number of elements to return (default: 10)")
      },
    },
    async ({ browserId, selector, limit }) => {
      const connection = browserConnections.get(browserId);
      if (!connection || !connection.connected) {
        throw new Error(`Browser ${browserId} is not connected. Use Browser_connect first.`);
      }
      
      const result = await connection.rpc.getElements({ selector, limit });
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Browser_waitForElement",
    {
      title: "Wait for Element to Appear",
      description: "Waits for an element to appear in the DOM before proceeding. Useful for handling dynamic content, AJAX responses, or animations. Polls for the element's presence and returns once found or timeout is reached. The browser must be connected via Browser_connect first.",
      inputSchema: {
        browserId: z.string().describe("Browser connection ID from Browser_connect"),
        selector: z.object({
          type: z.enum(["id", "text", "css", "xpath"]).describe("Type of selector to use"),
          value: z.string().describe("Selector value"),
          tagName: z.string().optional().describe("Optional tag name filter when using text selector")
        }).describe("Element selector specification"),
        timeout: z.number().optional().default(5000).describe("Maximum time to wait in milliseconds (default: 5000)")
      },
    },
    async ({ browserId, selector, timeout }) => {
      const connection = browserConnections.get(browserId);
      if (!connection || !connection.connected) {
        throw new Error(`Browser ${browserId} is not connected. Use Browser_connect first.`);
      }
      
      const result = await connection.rpc.waitForElement({
        type: selector.type,
        value: selector.value,
        tagName: selector.tagName,
        timeout
      });
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Browser_getPageInfo",
    {
      title: "Get Browser Page Information",
      description: "Retrieves comprehensive information about the current page in the connected browser including URL, title, viewport dimensions, and ready state. Useful for verification, debugging, and understanding the current browser context. The browser must be connected via Browser_connect first.",
      inputSchema: {
        browserId: z.string().describe("Browser connection ID from Browser_connect")
      },
    },
    async ({ browserId }) => {
      const connection = browserConnections.get(browserId);
      if (!connection || !connection.connected) {
        throw new Error(`Browser ${browserId} is not connected. Use Browser_connect first.`);
      }
      
      const result = await connection.rpc.getPageInfo();
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(result, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Browser_disconnect",
    {
      title: "Disconnect Browser Control",
      description: "Closes the WebSocket connection to a connected browser and cleans up resources. Use this when you're done controlling a browser to free up connections. The browser-side script will attempt to reconnect automatically unless the page is closed.",
      inputSchema: {
        browserId: z.string().describe("Browser connection ID to disconnect")
      },
    },
    async ({ browserId }) => {
      const connection = browserConnections.get(browserId);
      if (!connection) {
        throw new Error(`Browser ${browserId} not found`);
      }
      
      if (connection.ws) {
        connection.ws.close();
      }
      
      browserConnections.delete(browserId);
      
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              browserId,
              message: "Browser disconnected successfully"
            }, null, 2)
          },
        ],
      };
    }
  )

mcp.registerTool(
    "Console_getBackendLogs",
    {
      title: "Retrieve Backend Console Logs",
      description: "Access comprehensive console output from the backend/server-side Bun process, capturing all server-side logging activity. This essential debugging tool intercepts all console API calls (log, info, warn, error, debug, trace, assert) from your backend Node.js/Bun code via the Console.messageAdded inspector event. Unlike frontend log tools, this captures SERVER-SIDE logs including application startup messages, API request logging, database queries, error stack traces, debug output, and system warnings. Each log entry includes severity level, timestamp, source location (file:line:column), full text content, and stack traces for errors. Perfect for debugging server issues, monitoring application health, tracking API performance, investigating production errors, and understanding server-side program flow. Supports filtering by severity level and text search.",
      inputSchema: {
        limit: z.number().optional().default(100).describe("Maximum number of log entries to retrieve, sorted by newest first (default: 100)"),
        level: z.enum(["log", "info", "warning", "error", "debug"]).optional().describe("Filter logs by severity level. Leave empty to retrieve all levels"),
        search: z.string().optional().describe("Search for logs containing this text (case-insensitive)"),
      },
    },
  async ({ limit, level, search }) => {
        let logs = [...backendConsoleLogs];
        
        // Apply filters
        if (level !== undefined) {
          logs = logs.filter(log => log.level === level);
        }
        if (search !== undefined) {
          const searchLower = search.toLowerCase();
          logs = logs.filter(log => log.text.toLowerCase().includes(searchLower));
        }
        
        // Sort by newest first and limit
        logs = logs.slice(-limit).reverse();
        
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                count: logs.length,
                totalCount: backendConsoleLogs.length,
                logs: logs.map(log => ({
                  timestamp: log.timestamp,
                  level: log.level,
                  text: log.text,
                  source: log.source,
                  type: log.type,
                  location: log.url ? `${log.url}:${log.line || 0}:${log.column || 0}` : undefined,
                  stackTrace: log.stackTrace
                }))
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
      description: "Lists all JavaScript files currently loaded and parsed by the Bun runtime debugger. This essential tool provides a complete inventory of debuggable scripts, including their unique scriptIds (required for some debugging operations), file URLs/paths, line ranges, execution contexts, and module types. Use this to discover script IDs for setting breakpoints, find all loaded modules and dependencies, identify anonymous scripts and eval'd code, check which files have source maps, and understand the full scope of loaded code. Results include both application code and dependencies, with filtering capabilities to find specific scripts quickly. Each script entry shows whether it's a module, has source maps, and its execution context.",
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
      description: "Retrieves the complete source code of any JavaScript file loaded in the Bun runtime using its scriptId. This powerful inspection tool provides access to the exact code being executed, including dynamically generated code, eval'd scripts, and transformed modules. Essential for determining precise line numbers for breakpoints, understanding minified or transpiled code, inspecting dependency implementations, viewing code that's not on disk, and debugging dynamically loaded modules. Returns both the source text and bytecode if available. First use Debugger_getScripts to find script IDs, then use this tool to examine any script's contents. Works with all script types including modules, classic scripts, and inline code.",
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

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>()

// WebSocket endpoint for browser control
app.get(
  "/_ws_browser",
  upgradeWebSocket(() => {
    return {
      onOpen(event, ws) {
        console.log("[Browser Control] New WebSocket connection");
        
        // Find pending connection or create new one
        let connectionId: string | null = null;
        for (const [id, conn] of browserConnections) {
          if (!conn.connected) {
            connectionId = id;
            break;
          }
        }
        
        if (!connectionId) {
          console.log("[Browser Control] No pending connection found, creating new one");
          connectionId = `browser-${Date.now()}`;
          browserConnections.set(connectionId, {
            id: connectionId,
            ws: null,
            rpc: null,
            url: "",
            connected: false
          });
        }
        
        const connection = browserConnections.get(connectionId)!;
        connection.ws = ws;
        connection.connected = true;
        
        // Store connection ID in WebSocket context
        (ws as any).connectionId = connectionId;
        
        // Create birpc instance
        // Server exposes serverFunctions, and gets back an rpc object to call BrowserFunctions
        const serverFunctions = createServerFunctions(connectionId);
        
        // First set up the handler storage and buffer
        (ws as any).messageHandler = null;
        (ws as any).bufferedMessages = [];
        
        connection.rpc = createBirpc<BrowserFunctions, typeof serverFunctions>(serverFunctions, {
          post: (data) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.send(data);
            }
          },
          on: (handler) => {
            (ws as any).messageHandler = handler;
            
            // Process any buffered messages immediately when handler is set
            if ((ws as any).bufferedMessages) {
              console.log(`[Browser Control] Processing ${(ws as any).bufferedMessages.length} buffered messages`);
              for (const msg of (ws as any).bufferedMessages) {
                handler(msg);
              }
              delete (ws as any).bufferedMessages;
            }
          },
          serialize: (data) => JSON.stringify(data),
          deserialize: (data) => JSON.parse(data),
        });
        
        console.log(`[Browser Control] Connected as ${connectionId}`);
      },
      
      onMessage(event, ws) {
        console.log('[Browser Control] Received message:', event.data);
        
        if (typeof event.data === 'string') {
          const handler = (ws as any).messageHandler;
          if (handler) {
            console.log('[Browser Control] Passing message to handler');
            handler(event.data);
          } else {
            // Buffer messages that arrive before handler is ready
            if (!(ws as any).bufferedMessages) {
              (ws as any).bufferedMessages = [];
            }
            (ws as any).bufferedMessages.push(event.data);
            console.log('[Browser Control] Buffering message, handler not ready yet');
          }
        } else {
          console.log('[Browser Control] Ignoring non-string message');
        }
      },
      
      onClose(event, ws) {
        const connectionId = (ws as any).connectionId;
        if (connectionId) {
          browserConnections.delete(connectionId);
          console.log(`[Browser Control] Disconnected and removed: ${connectionId}`);
        }
      },
      
      onError(event, ws) {
        console.error("[Browser Control] WebSocket error:", event);
      },
    };
  })
);


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

// Add event listener for backend console messages
session.addEventListener("Console.messageAdded", (params: JSC.Console.MessageAddedEvent) => {
  const msg = params.message;
  backendConsoleLogs.push({
    source: msg.source,
    level: msg.level,
    text: msg.text,
    type: msg.type,
    timestamp: new Date(),
    stackTrace: msg.stackTrace,
    line: msg.line,
    column: msg.column,
    url: msg.url
  });
});

// Add event listener for debugger paused events
session.addEventListener("Debugger.paused", (params: JSC.Debugger.PausedEvent) => {
  console.log("Debugger paused:", {
    reason: params.reason,
    callFrames: params.callFrames.map(frame => ({
      functionName: frame.functionName || "<anonymous>",
      location: `${frame.location.scriptId}:${frame.location.lineNumber}:${frame.location.columnNumber || 0}`,
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
    executionContextId: undefined, // Not available in the event
    hash: undefined, // Not available in the event
    isContentScript: params.isContentScript,
    isModule: params.module,
    sourceMapURL: params.sourceMapURL,
    hasSourceURL: !!params.sourceURL,
    length: undefined // Not available in the event
  };
  
  parsedScripts.set(params.scriptId, scriptInfo);
  
  console.log("Script parsed:", {
    scriptId: params.scriptId,
    url: params.url || "<anonymous>",
    startLine: params.startLine,
    startColumn: params.startColumn,
    endLine: params.endLine,
    endColumn: params.endColumn,
    isModule: params.module
  });
});

const port = 4000;
console.log(`MCP server listening on http://localhost:${port}/mcp`);

Bun.serve({
  fetch: app.fetch,
  websocket,
  port,
});

console.log(`Browser control WebSocket available at ws://localhost:${port}/_ws_browser`);
