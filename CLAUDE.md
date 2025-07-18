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
- **Conditional Breakpoints**:
  - Break only when condition is true: `condition: "count > 10"`
  - Break on specific user: `condition: "user.id === 'admin'"`
  - Break on error states: `condition: "response.status >= 400"`
  - Complex conditions: `condition: "items.length > 0 && items[0].price > 100"`

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

### 5. Call Frame Evaluation and Variable Inspection

#### `Debugger_evaluateOnCallFrame`
- **Purpose**: Execute code in the context of a paused call frame
- **When to use**: To inspect local variables, evaluate expressions in paused scope
- **Prerequisites**: 
  1. Debugger must be paused (at breakpoint or via `Debugger_pause`)
  2. Must have callFrameId from the pause event
- **Features**: Access to local variables, `this`, arguments, etc.
- **Advanced Usage**:
  - Inspect nested object properties: `JSON.stringify(myObject, null, 2)`
  - Check variable types: `typeof variable` or `variable.constructor.name`
  - Explore prototype chain: `Object.getPrototypeOf(obj)`
  - List all properties: `Object.getOwnPropertyNames(obj)`
  - Inspect function details: `functionName.toString()`

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

## Browser Control Tools

The MCP server includes powerful browser automation capabilities via WebSocket connection at `/_ws_browser` endpoint. These tools allow you to remotely control any browser that has loaded the `browser-control.js` script.

### Setup

1. **Load the control script** in your target browser:
   ```html
   <script src="https://cdn.jsdelivr.net/gh/ryoppippi/bun-inspect-mcp/browser-control.js"></script>
   ```
   Or via browser console:
   ```javascript
   const script = document.createElement('script');
   script.src = 'https://cdn.jsdelivr.net/gh/ryoppippi/bun-inspect-mcp/browser-control.js';
   document.head.appendChild(script);
   ```

2. **Connect from MCP** using `Browser_connect` tool

### Browser Control Tools

#### `Browser_list`
- **Purpose**: List all browser connections (active and pending)
- **When to use**: Before connecting to check existing connections
- **Returns**: List of all browser IDs with their connection status

#### `Browser_connect`
- **Purpose**: Establish WebSocket connection to a browser
- **When to use**: After checking Browser_list, before using other browser control tools
- **Returns**: Connection status and browser ID

#### `Browser_click`
- **Purpose**: Click elements in the browser
- **Selector types**:
  - `id`: Find by element ID
  - `text`: Find by exact text content
  - `css`: Find by CSS selector
  - `xpath`: Find by XPath expression
- **Options**: Mouse button, coordinates, modifier keys

#### `Browser_input`
- **Purpose**: Type text into input fields
- **Features**: Auto-focus, clear existing content, trigger events
- **Works with**: input, textarea, contenteditable elements

#### `Browser_evaluate`
- **Purpose**: Execute JavaScript in browser context
- **Access**: Full DOM, window object, all browser APIs
- **Returns**: Evaluation result or error

#### `Browser_getElements`
- **Purpose**: Query DOM elements and get their properties
- **Returns**: Element details including attributes, text, position
- **Limit**: Control number of results returned

#### `Browser_waitForElement`
- **Purpose**: Wait for dynamic content to appear
- **Use cases**: AJAX responses, animations, lazy loading
- **Timeout**: Configurable wait duration

#### `Browser_getPageInfo`
- **Purpose**: Get current page information
- **Returns**: URL, title, viewport size, ready state

#### `Browser_disconnect`
- **Purpose**: Close browser connection
- **Note**: Browser will attempt to reconnect automatically

### Browser Control Workflow Example

```
1. Browser_list() // Check existing connections first
2. Browser_connect(browserId: "myBrowser")
3. Browser_waitForElement(browserId: "myBrowser", selector: {type: "id", value: "login-form"})
4. Browser_input(browserId: "myBrowser", selector: {type: "id", value: "username"}, text: "user@example.com")
5. Browser_input(browserId: "myBrowser", selector: {type: "id", value: "password"}, text: "secretpass")
6. Browser_click(browserId: "myBrowser", selector: {type: "text", value: "Sign In", tagName: "button"})
7. Browser_evaluate(browserId: "myBrowser", expression: "window.location.href")
```

### Advanced Browser Automation

```javascript
// Extract data from a table
Browser_evaluate(browserId: "browser1", expression: `
  Array.from(document.querySelectorAll('table tr')).map(row => 
    Array.from(row.cells).map(cell => cell.textContent.trim())
  )
`)

// Wait for AJAX to complete
Browser_waitForElement(browserId: "browser1", 
  selector: {type: "css", value: ".results-loaded"}, 
  timeout: 10000
)

// Interact with dropdown
Browser_click(browserId: "browser1", selector: {type: "css", value: "select#country"})
Browser_click(browserId: "browser1", selector: {type: "text", value: "United States", tagName: "option"})

// Handle file upload (simulate)
Browser_evaluate(browserId: "browser1", expression: `
  const input = document.querySelector('input[type="file"]');
  // Note: Can't actually select files due to security, but can trigger events
  input.dispatchEvent(new Event('change', {bubbles: true}));
`)
```

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

### Exploring Complex Objects
```
1. Debugger_setBreakpointByUrl(url: "file:///path/to/api.js", lineNumber: 123)
2. Wait for breakpoint hit
3. Debugger_evaluateOnCallFrame(callFrameId: "...", expression: "Object.keys(request.body)")
4. Debugger_evaluateOnCallFrame(callFrameId: "...", expression: "JSON.stringify(user, null, 2)")
5. Debugger_evaluateOnCallFrame(callFrameId: "...", expression: "Object.entries(headers).forEach(([k,v]) => console.log(`${k}: ${v}`))")
```

### Monitoring logs
```
1. BunFrontendDevServer_getConsoleLogs(limit: 50, kind: "error")  // Frontend logs
2. Console_getBackendLogs(level: "error", search: "database")      // Backend logs
3. BunFrontendDevServer_getClientErrors(decode: true)              // Client errors
```

### Performance Debugging
```
1. Runtime_evaluate(expression: "console.time('operation')")
2. // Let code execute
3. Runtime_evaluate(expression: "console.timeEnd('operation')")
4. Console_getBackendLogs(search: "operation")

// Memory profiling
5. Runtime_evaluate(expression: "console.log(process.memoryUsage())")
6. Runtime_evaluate(expression: "global.gc && global.gc()")  // If --expose-gc flag is set

// CPU profiling with breakpoints
7. Debugger_setBreakpointByUrl(url: "file:///path/to/hotspot.js", lineNumber: 50)
8. // Measure time between breakpoint hits to identify bottlenecks
```

### Async/Promise Debugging
```
// Debug promise chains
1. Debugger_setBreakpointByUrl(url: "file:///path/to/async.js", lineNumber: 75, condition: "promise.state === 'rejected'")
2. Runtime_evaluate(expression: "process.on('unhandledRejection', (reason, promise) => { console.error('Unhandled Rejection:', reason); debugger; })")

// Track async operations
3. Debugger_evaluateOnCallFrame(callFrameId: "...", expression: "Promise.resolve(asyncOperation).then(r => console.log('Result:', r)).catch(e => console.error('Error:', e))")

// Debug async/await
4. Debugger_setBreakpointByUrl(url: "file:///path/to/service.js", lineNumber: 100)  // Set before await
5. Debugger_stepOver()  // Step over await to see resolved value
6. Debugger_evaluateOnCallFrame(callFrameId: "...", expression: "result")  // Inspect awaited value

// Monitor promise states
7. Runtime_evaluate(expression: `
  const promises = new Map();
  const OriginalPromise = Promise;
  global.Promise = new Proxy(OriginalPromise, {
    construct(target, args) {
      const promise = new target(...args);
      promises.set(promise, { created: new Date(), state: 'pending' });
      promise.then(() => promises.get(promise).state = 'fulfilled')
             .catch(() => promises.get(promise).state = 'rejected');
      return promise;
    }
  });
`)
```

## Troubleshooting Common Issues

### Connection Problems
- **Issue**: "Cannot connect to debugger"
  - **Solution**: Ensure Bun is running with `--inspect` flag
  - **Check**: Inspector URL is accessible (default: ws://localhost:6499)

### Breakpoint Issues
- **Issue**: "Breakpoint not hitting"
  - **Verify**: File path matches exactly (use `Debugger_getScripts` to confirm)
  - **Check**: Code is actually executed (add console.log to verify)
  - **Remember**: Breakpoints only work on backend code, not frontend

### Evaluation Errors
- **Issue**: "Variable is not defined"
  - **Ensure**: Debugger is paused at correct scope
  - **Use**: `Debugger_evaluateOnCallFrame` instead of `Runtime_evaluate` for local variables
  - **Try**: Checking the call stack to ensure you're in the right frame

### Performance Considerations
- **Large Objects**: Use `JSON.stringify` with depth limit for huge objects
- **Frequent Breakpoints**: Can slow down execution significantly
- **Console Logs**: Filter by level to reduce noise

This guide should help you effectively use all the debugging and inspection tools available in the Bun Inspector MCP.