# Bun Inspector MCP Tools Guide

This guide explains all available MCP tools for debugging and inspecting Bun applications, including their relationships and typical workflows.

## Overview

The Bun Inspector MCP provides tools to interact with Bun's JavaScript inspector protocol, enabling debugging, code evaluation, and monitoring of Bun applications.

## Tool Categories

### 1. Runtime Evaluation Tools

#### `Runtime_evaluate`
- **Purpose**: Execute JavaScript expressions in the Bun runtime context
- **When to use**: For quick code evaluation, testing expressions, or inspecting global state
- **No prerequisites**: Can be used anytime during runtime

### 2. Debugger Control Tools

These tools work together to provide full debugging capabilities:

#### `Debugger_pause`
- **Purpose**: Pause JavaScript execution at the next opportunity
- **When to use**: To halt execution and inspect program state
- **Emits**: `Debugger.paused` event with call stack information

#### `Debugger_resume`
- **Purpose**: Resume JavaScript execution after being paused
- **When to use**: After inspecting state at a breakpoint or pause
- **Prerequisite**: Debugger must be paused

#### `Debugger_stepInto`
- **Purpose**: Step into the next function call
- **When to use**: To debug inside function implementations
- **Prerequisite**: Debugger must be paused

#### `Debugger_stepOut`
- **Purpose**: Step out of the current function
- **When to use**: To return to the calling function
- **Prerequisite**: Debugger must be paused

#### `Debugger_stepOver`
- **Purpose**: Step over the next statement
- **When to use**: To execute the next line without entering functions
- **Prerequisite**: Debugger must be paused

### 3. Breakpoint Management Tools

**Important**: Breakpoints only work on backend/server-side code executed by Bun. They do not work on frontend/client-side code running in the browser.

#### `Debugger_setBreakpointByUrl` (Recommended)
- **Purpose**: Set breakpoints using file paths or URL patterns
- **When to use**: When you know the file path but not the scriptId
- **Advantages**: No need to find scriptId first, works with file paths directly
- **Example**: Set breakpoint in `/path/to/file.js` at line 42
- **Limitation**: Only works for backend code executed by Bun

#### `Debugger_setBreakpoint`
- **Purpose**: Set breakpoints using scriptId
- **When to use**: When you have the exact scriptId
- **Prerequisite**: Must know scriptId (use `Debugger_getScripts` first)
- **Features**: Supports conditional breakpoints and actions
- **Limitation**: Only works for backend code executed by Bun

#### `Debugger_removeBreakpoint`
- **Purpose**: Remove a previously set breakpoint
- **When to use**: To clean up breakpoints no longer needed
- **Prerequisite**: Must have the breakpointId from when it was created

### 4. Script Inspection Tools

#### `Debugger_getScripts`
- **Purpose**: List all parsed JavaScript files with their scriptIds
- **When to use**: To find scriptIds for setting breakpoints or viewing source
- **Features**: Can filter by URL or scriptId

#### `Debugger_getScriptSource`
- **Purpose**: Retrieve source code of a specific script
- **When to use**: To view code and determine line numbers for breakpoints
- **Prerequisite**: Must know scriptId (use `Debugger_getScripts` first)

### 5. Call Frame Evaluation

#### `Debugger_evaluateOnCallFrame`
- **Purpose**: Execute code in the context of a paused call frame
- **When to use**: To inspect local variables, evaluate expressions in paused scope
- **Prerequisites**: 
  1. Debugger must be paused (at breakpoint or via `Debugger_pause`)
  2. Must have callFrameId from the pause event
- **Features**: Access to local variables, `this`, arguments, etc.

### 6. Console and Logging Tools

#### `BunFrontendDevServer_getConsoleLogs`
- **Purpose**: Retrieve console logs from Bun's frontend dev server
- **When to use**: To monitor frontend/client-side application logging
- **Features**: Filter by log type, server instance, or limit count

#### `Console_getBackendLogs`
- **Purpose**: Retrieve console logs from backend/server-side Bun process
- **When to use**: To monitor backend console.log, console.error, etc. calls
- **Features**: Filter by severity level, search text, or limit count
- **Note**: Captures all backend console API calls via Console.messageAdded event

#### `BunFrontendDevServer_getClientErrors`
- **Purpose**: Retrieve client-side errors reported to the dev server
- **When to use**: To debug frontend errors and exceptions
- **Features**: Decode error payloads, filter by server instance

## Common Workflows

### Basic Debugging Workflow

1. **Set a breakpoint** (choose one):
   - Use `Debugger_setBreakpointByUrl` with file path (easier)
   - Use `Debugger_getScripts` → `Debugger_setBreakpoint` with scriptId

2. **Wait for execution to pause** at the breakpoint
   - The `Debugger.paused` event provides call stack with callFrameIds

3. **Inspect the paused state**:
   - Use `Debugger_evaluateOnCallFrame` with callFrameId to inspect variables
   - Use `Runtime_evaluate` for global scope evaluation

4. **Control execution**:
   - `Debugger_stepInto` to enter functions
   - `Debugger_stepOver` to skip function calls
   - `Debugger_stepOut` to exit current function
   - `Debugger_resume` to continue normally

### Finding and Inspecting Code

1. **List available scripts**: Use `Debugger_getScripts`
2. **View source code**: Use `Debugger_getScriptSource` with scriptId
3. **Set breakpoints**: Use line numbers from source to set precise breakpoints

### Monitoring Application

1. **Frontend console logs**: Use `BunFrontendDevServer_getConsoleLogs` for frontend/client-side logs
2. **Backend console logs**: Use `Console_getBackendLogs` for backend/server-side logs
3. **Client errors**: Use `BunFrontendDevServer_getClientErrors` to check for frontend issues
4. **Runtime evaluation**: Use `Runtime_evaluate` to check application state

## Important Notes

- **Script IDs**: These are assigned by the debugger when scripts are parsed. They're required for some tools but you can avoid needing them by using `Debugger_setBreakpointByUrl`.

- **Paused State**: Many debugger operations require the debugger to be paused. Set a breakpoint or use `Debugger_pause` first.

- **Call Frame IDs**: These are only available when the debugger is paused and come from the pause event's call stack.

- **Events**: The debugger emits events (paused, resumed, scriptParsed) that are logged to the console for visibility.

## Example Scenarios

### Debugging a specific function
```
1. Debugger_setBreakpointByUrl(url: "file:///path/to/app.js", lineNumber: 45)
2. Wait for breakpoint hit (see console for pause event)
3. Debugger_evaluateOnCallFrame(callFrameId: "...", expression: "localVariable")
4. Debugger_stepInto() to debug deeper
5. Debugger_resume() when done
```

### Quick code evaluation
```
1. Runtime_evaluate(expression: "Object.keys(globalThis)")
2. Runtime_evaluate(expression: "document.querySelector('.my-element')")
```

### Monitoring logs
```
1. BunFrontendDevServer_getConsoleLogs(limit: 50, kind: "error")  // Frontend logs
2. Console_getBackendLogs(level: "error", search: "database")      // Backend logs
3. BunFrontendDevServer_getClientErrors(decode: true)              // Client errors
```

This guide should help you effectively use all the debugging and inspection tools available in the Bun Inspector MCP.