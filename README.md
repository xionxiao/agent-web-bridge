# agent-web-bridge

Mirror your local agent CLI session to any browser via WebSocket.

## Usage

**Prerequisite:** `node-pty` is a native module — you need `make`, `gcc`/`clang`, and `python3` installed for `npm install` to compile it.

```bash
# Install globally from GitHub, then run
npm install -g github:xionxiao/agent-web-bridge
agent-web-bridge

# Or run directly without installing (auto-caches)
npx github:xionxiao/agent-web-bridge

# Custom port
npx github:xionxiao/agent-web-bridge --port 4000

# Choose agent (claude or opencode)
npx github:xionxiao/agent-web-bridge --agent=opencode

# Pass extra arguments to agent
npx github:xionxiao/agent-web-bridge --agent=opencode --args="--model=gpt-4"

# Custom agent binary path
AGENT_BIN=/path/to/claude npx github:xionxiao/agent-web-bridge
```

Then open `http://localhost:3001`.
