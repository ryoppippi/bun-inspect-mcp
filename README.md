# bun-inspect-echo

A debugging tool that captures and displays the inspector protocol messages for Bun processes.

## Installation

```bash
bunx bun-inspect-echo [script] <...args>

# or permanently install
bun install -g bun-inspect-echo
```

## Usage

```bash
# Run a bun script with inspector protocol output
bun-inspect-echo ./path/to/script.ts

# Works with any bun command
bun-inspect-echo test
bun-inspect-echo run foo
```

## Example Output

```
--------------------- Bun Inspector ---------------------
Listening on unix:///var/folders/wj/x9081kld0873cywddf9k8nfm0000gn/T/96splqxu49v.sock
--------------------- Bun Inspector ---------------------
{"result":{},"id":1}
{"result":{},"id":2}
{"method":"Heap.garbageCollected","params":{"collection":{"type":"partial","startTime":0.03853349993005395,"endTime":0.03875300008803606}}}
{"method":"Debugger.scriptParsed","params":{"scriptId":"2","url":"/Users/jarred/src/index.tsx","startLine":0,"startColumn":0,"endLine":11,"endColumn":0}}
{"method":"HTTPServer.listen","params":{"serverId":1,"url":"http://localhost:53406/","startTime":4165836274}}
```

## How It Works

This tool:

1. Creates a Unix domain socket
2. Launches a new Bun process with the `--inspect-wait` flag pointing to the socket
3. Connects to the inspector socket
4. Enables all inspector domains
5. Echoes all inspector protocol messages to stdout

## Environment Variables

- `BUN_INSPECTOR_DOMAINS`: Comma-separated list of inspector domains to enable (defaults to all domains)

## Use Cases

- Debugging Bun applications
- Understanding the underlying inspector protocol
- Learning how Bun starts and executes scripts
- Monitoring garbage collection and performance events

## License

MIT
