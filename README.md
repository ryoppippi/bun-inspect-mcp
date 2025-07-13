# bun-inspect-mcp

An MCP (Model Context Protocol) server that provides debugging and inspection tools for Bun applications through the Bun Inspector Protocol.

This tool uses the Bun Inspector Protocol based on https://github.com/oven-sh/bun/tree/main/packages/bun-inspector-protocol

## Overview

`bun-inspect-mcp` exposes the Bun JavaScript inspector protocol as MCP tools, enabling AI assistants like Claude to debug, inspect, and interact with running Bun applications. This includes setting breakpoints, stepping through code, evaluating expressions, and monitoring console logs.

## Features

- **Runtime Evaluation**: Execute JavaScript expressions in the Bun runtime
- **Debugger Control**: Pause, resume, step through code execution
- **Breakpoint Management**: Set and remove breakpoints by file path or script ID
- **Script Inspection**: View loaded scripts and their source code
- **Call Frame Evaluation**: Inspect variables and evaluate expressions in paused contexts
- **Console Monitoring**: Capture frontend and backend console logs

## Installation

```bash
# Clone the repository
git clone https://github.com/ryoppippi/bun-inspect-mcp
cd bun-inspect-mcp

# Install dependencies
bun install
```

## Usage

### Starting the MCP Server

The MCP server can be started in different ways:

```bash
# Run directly with Bun
bun run index.ts <target script>

# Or use the dev script
bun run dev <target script>

# Example: Start the server for a Bun application
bun run index.ts ./src/index.tsx
```
Then we launch the MCP server on port 4000 by default. 

### Integrating with Claude Desktop

Add this server to your Claude Desktop configuration:

```json
{
  "mcpServers": {
    "remote-example": {
      "command": "bunx",
      "args": [
        "mcp-remote",
        "http://localhost:4000/mcp"
      ]
    }
  }
}
```

> currently we don not support auth on http stream, and it does not work with Claude Code. We recommend using the `mcp-remote` command to prevent this issue.


## Available Tools

### Runtime Evaluation

- `Runtime_evaluate` - Execute JavaScript expressions in the runtime context

### Debugger Control

- `Debugger_pause` - Pause JavaScript execution
- `Debugger_resume` - Resume JavaScript execution
- `Debugger_stepInto` - Step into the next function call
- `Debugger_stepOut` - Step out of the current function
- `Debugger_stepOver` - Step over the next statement

### Breakpoint Management

- `Debugger_setBreakpointByUrl` - Set breakpoints using file paths (recommended)
- `Debugger_setBreakpoint` - Set breakpoints using script IDs
- `Debugger_removeBreakpoint` - Remove existing breakpoints

### Script Inspection

- `Debugger_getScripts` - List all parsed JavaScript files
- `Debugger_getScriptSource` - Retrieve source code of a specific script

### Call Frame Evaluation

- `Debugger_evaluateOnCallFrame` - Execute code in a paused call frame context

### Console and Logging

- `BunFrontendDevServer_getConsoleLogs` - Retrieve frontend console logs
- `Console_getBackendLogs` - Retrieve backend console logs
- `BunFrontendDevServer_getClientErrors` - Retrieve client-side errors

## Example Workflow

1. **Set a breakpoint in your code:**
   ```
   Debugger_setBreakpointByUrl(url: "file:///path/to/app.js", lineNumber: 45)
   ```

2. **When the breakpoint hits, inspect variables:**
   ```
   Debugger_evaluateOnCallFrame(callFrameId: "...", expression: "localVariable")
   ```

3. **Step through the code:**
   ```
   Debugger_stepInto()  // Enter function calls
   Debugger_stepOver()  // Skip to next line
   Debugger_resume()    // Continue execution
   ```

4. **Monitor logs:**
   ```
   Console_getBackendLogs(level: "error")
   BunFrontendDevServer_getConsoleLogs(kind: "error")
   ```

## Requirements

- Bun >= 1.2.19
- A running Bun application with inspector enabled

## Development

```bash
# Type checking
bun run typecheck

# Run in development mode
bun run dev
```

## Architecture

The MCP server connects to Bun's inspector protocol through a Unix domain socket, enabling bidirectional communication between the MCP client and the Bun runtime. It manages WebSocket connections, handles protocol framing, and exposes inspector functionality as MCP tools.

## License

MIT

## Contributing

Contributions are welcome! Please feel free to submit issues and pull requests.

## See Also

- [MCP (Model Context Protocol)](https://modelcontextprotocol.io/)
- [Bun Inspector Protocol](https://github.com/oven-sh/bun/tree/main/packages/bun-inspector-protocol)
- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/) (which Bun's protocol is based on)
