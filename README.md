# agent-web-bridge

Mirror your local agent CLI session to any browser via WebSocket.

## Usage

**Prerequisite:** `node-pty` is a native module — you need `make`, `gcc`/`clang`, and `python3` installed for `npm install` to compile it.

> **Windows users:** Install [Windows Build Tools](https://github.com/felixrieseberg/windows-build-tools) or run `npm install --vs2022` with Visual Studio 2022 Build Tools. OpenSSL is also required for `--https` — install via [Chocolatey](https://chocolatey.org/) (`choco install openssl`) or use a prebuilt binary.

```bash
# Run directly (server.js is the CLI entry point)
node server.js

# Or install globally
npm install -g github:xionxiao/agent-web-bridge
agent-web-bridge

# Or run via npx
npx github:xionxiao/agent-web-bridge

# Options
node server.js --port=4000 --agent=opencode --args="--model=gpt-4"
node server.js --auth=mysecret                          # require ?token=mysecret
node server.js --https                                  # enable HTTPS
AGENT_BIN=/path/to/agent node server.js                 # custom binary
PORT=4000 HOST=127.0.0.1 node server.js                 # env vars
```

Then open `http://localhost:3001`. If `--auth` is set, append `?token=mysecret` to the URL.
