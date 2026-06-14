const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { spawn } = require('node-pty');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const HTTP_PORT = process.env.PORT || 3001;
const CLAUDE_BIN = process.env.CLAUDE_BIN || '/home/xhui/.local/bin/claude';

// ---------------------------------------------------------------------------
// Express + HTTP server (serves web page + WebSocket)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const httpServer = http.createServer(app);
const wss = new WebSocketServer({ server: httpServer });

// ---------------------------------------------------------------------------
// WebSocket clients (web mirrors)
// ---------------------------------------------------------------------------
const wsClients = new Set();

function broadcastToWeb(data) {
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      try {
        ws.send(JSON.stringify({ type: 'data', data }));
      } catch (_) {}
    }
  }
}

function broadcastControlToWeb(jsonMsg) {
  for (const ws of wsClients) {
    if (ws.readyState === 1) {
      try { ws.send(jsonMsg); } catch (_) {}
    }
  }
}

wss.on('connection', (ws) => {
  wsClients.add(ws);
  console.log('[ws] Web client connected (%d total)', wsClients.size);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (_) { return; }

    if (msg.type === 'input' && ptyProcess && !ptyExited) {
      ptyProcess.write(msg.data);
    } else if (msg.type === 'resize') {
      const { cols, rows } = msg;
      if (
        typeof cols === 'number' && typeof rows === 'number' &&
        cols >= 2 && rows >= 2 && cols <= 500 && rows <= 500
      ) {
        if (ptyProcess && !ptyExited) {
          try { ptyProcess.resize(cols, rows); } catch (_) {}
        }
      }
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    console.log('[ws] Web client disconnected (%d total)', wsClients.size);
  });

  ws.on('error', () => {
    wsClients.delete(ws);
  });
});

// ---------------------------------------------------------------------------
// PTY state
// ---------------------------------------------------------------------------
let ptyProcess = null;
let ptyExited = false;

// ---------------------------------------------------------------------------
// Start HTTP server first, then take over terminal and spawn claude
// ---------------------------------------------------------------------------
httpServer.listen(HTTP_PORT, () => {
  console.log('[http] Web server at http://localhost:%d', HTTP_PORT);
  console.log('[http] Open the URL above in a browser to mirror this session.');
  console.log('');

  startPty();
});

// ---------------------------------------------------------------------------
// Spawn claude PTY, pipe terminal stdio, broadcast to web
// ---------------------------------------------------------------------------
function startPty() {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;

  try {
    ptyProcess = spawn(CLAUDE_BIN, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: process.cwd(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
      },
    });
  } catch (err) {
    console.error('[pty] Failed to spawn Claude:', err.message);
    process.exit(1);
  }

  console.log('[pty] Claude PID: %d, size: %dx%d', ptyProcess.pid, cols, rows);

  // ---- PTY output → terminal stdout + web broadcast -------------------
  ptyProcess.onData((data) => {
    if (ptyExited) return;
    process.stdout.write(data);
    broadcastToWeb(data);
  });

  // ---- PTY exit -------------------------------------------------------
  ptyProcess.onExit(({ exitCode, signal }) => {
    ptyExited = true;
    broadcastControlToWeb(
      JSON.stringify({ type: 'exit', code: exitCode, signal: signal || null })
    );
    shutdown(exitCode);
  });

  // ---- Terminal input → PTY ------------------------------------------
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    process.stdin.on('data', (data) => {
      if (ptyProcess && !ptyExited) {
        ptyProcess.write(data);
      }
    });

    // ---- Terminal resize → PTY ---------------------------------------
    process.stdout.on('resize', () => {
      const c = process.stdout.columns || 80;
      const r = process.stdout.rows || 24;
      if (ptyProcess && !ptyExited) {
        try { ptyProcess.resize(c, r); } catch (_) {}
      }
    });

    console.log('[pty] Terminal input active (raw mode)');
  } else {
    console.log('[pty] stdin is not a TTY - web-only mode (terminal input disabled)');
  }
}

// ---------------------------------------------------------------------------
// Cleanup and restore terminal
// ---------------------------------------------------------------------------
function shutdown(code) {
  if (ptyProcess) {
    try {
      const pid = ptyProcess.pid;
      try { process.kill(-pid, 'SIGTERM'); } catch (_) {}
      ptyProcess.kill('SIGHUP');
    } catch (_) {}
    ptyProcess = null;
  }
  ptyExited = true;

  // Restore terminal
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  // Close servers
  wss.close();
  httpServer.close();

  process.exit(code || 0);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('exit', () => {
  if (ptyProcess) {
    try { ptyProcess.kill('SIGKILL'); } catch (_) {}
  }
});
