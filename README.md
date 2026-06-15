# agent-web-bridge

Mirror your local agent CLI session to any browser via WebSocket.

## Usage

```bash
# Install dependencies
npm install

# Or use npx
npx agent-web-bridge

# Custom port
npx agent-web-bridge --port 4000

# Custom claude binary path
CLAUDE_BIN=/path/to/claude npm start
```

Then open `http://localhost:3001`.
