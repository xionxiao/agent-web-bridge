# agent-web-bridge

A bridge that mirrors a local Claude CLI session to the browser. It spawns a PTY running `claude` and syncs I/O bidirectionally via WebSocket to xterm.js in the browser, so the local terminal and remote web page are two views of the same session.

## Usage

```bash
# Install dependencies
npm install

# Start (default port 3001)
npm start

# Dev mode (auto-restart on file changes)
npm run dev

# Custom port
PORT=4000 npm start

# Custom claude binary path
CLAUDE_BIN=/path/to/claude npm start
```

Then open `http://localhost:3001`.
