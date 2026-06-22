const os = require('os');
const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');
const path = require('path');
const { execFileSync } = require('child_process');
const { WebSocketServer } = require('ws');
const { spawn } = require('node-pty');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const HTTP_PORT = process.env.PORT || 3001;
const HTTP_HOST = process.env.HOST || '0.0.0.0';
const USE_HTTPS = process.env.HTTPS === 'true';
const CERT_DIR = path.join(process.env.HOME || process.cwd(), '.config', 'agent-web-bridge');

function ensureCert() {
  if (!USE_HTTPS) return;
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) return;

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const subj = `/CN=${HTTP_HOST === '0.0.0.0' ? 'localhost' : HTTP_HOST}`;
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyFile, '-out', certFile,
      '-days', '365', '-nodes',
      '-subj', subj,
    ], { stdio: 'pipe' });
    console.log('[tls] Self-signed certificate generated in', CERT_DIR);
  } catch (err) {
    // Remove partial files so next startup retries
    try { fs.unlinkSync(keyFile); } catch (_) {}
    try { fs.unlinkSync(certFile); } catch (_) {}
    console.error('[tls] Failed to generate certificate. Is openssl installed?');
    process.exit(1);
  }
}

function getLocalIP() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return HTTP_HOST;
}
const AGENT_BIN = process.env.CLAUDE_BIN || (process.env.HOME && `${process.env.HOME}/.local/bin/claude`);
const AGENT_ARGS = (() => { try { return JSON.parse(process.env.AGENT_ARGS || '[]'); } catch { return []; } })();

// ---------------------------------------------------------------------------
// Express + HTTP server (serves web page + WebSocket)
// ---------------------------------------------------------------------------
ensureCert();

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const httpServer = USE_HTTPS
  ? https.createServer({ key: fs.readFileSync(path.join(CERT_DIR, 'key.pem')), cert: fs.readFileSync(path.join(CERT_DIR, 'cert.pem')) }, app)
  : http.createServer(app);
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
httpServer.listen(HTTP_PORT, HTTP_HOST, () => {
  ensureCert();
  const proto = USE_HTTPS ? 'https' : 'http';
  console.log('[http] Web server at %s://%s:%d', proto, getLocalIP(), HTTP_PORT);
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
    ptyProcess = spawn(AGENT_BIN, AGENT_ARGS, {
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
    console.error('[pty] Failed to spawn agent:', err.message);
    process.exit(1);
  }

  console.log('[pty] Agent PID: %d, size: %dx%d, args: %o', ptyProcess.pid, cols, rows, AGENT_ARGS);

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
