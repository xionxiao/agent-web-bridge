#!/usr/bin/env node
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
// CLI argument parsing
// ---------------------------------------------------------------------------
const AGENT_MAP = {
  'claude':    'claude',
  'opencode':  'opencode',
  'codex':     'codex',
  'kiro':      'kiro-cli',
  'kiro-cli':  'kiro-cli',
};

function printHelp() {
  const agents = Object.keys(AGENT_MAP).join(', ');
  console.log(`
agent-web-bridge — bridge a local agent CLI session to the browser.

USAGE
  agent-web-bridge [options]

OPTIONS
  -h, --help            Show this help message and exit.
      --port=<port>     HTTP/WebSocket port (default: 3001, or $PORT).
      --https           Enable HTTPS with a self-signed certificate.
      --auth=<token>    Require ?token=<token> to access the WebSocket.
      --agent=<name>    Agent to launch. Supported: ${agents}.
                        Default: claude.
      --args=<args>     Extra arguments forwarded to the agent, space-separated.

ENVIRONMENT
  PORT          Overrides the default port (same as --port).
  HOST          Bind address, default 0.0.0.0 (same as --host).
  HTTPS         Set to "true" to enable HTTPS (same as --https).

EXAMPLES
  agent-web-bridge
  agent-web-bridge --port=4000 --agent=opencode
  agent-web-bridge --agent=codex --args="--model gpt-5"
  agent-web-bridge --auth=mysecret
  PORT=4000 agent-web-bridge
`.trim());
}

let HTTP_PORT = parseInt(process.env.PORT, 10) || 3001;
let HTTP_HOST = process.env.HOST || '0.0.0.0';
let USE_HTTPS = process.env.HTTPS === 'true';
let AGENT_BIN = process.env.AGENT_BIN || 'claude';
let AGENT_ARGS = [];
let AUTH_TOKEN = '';

const cliArgs = process.argv.slice(2);
for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === '--help' || cliArgs[i] === '-h') {
    printHelp();
    process.exit(0);
  } else if (cliArgs[i] === '--https') {
    USE_HTTPS = true;
  } else if (cliArgs[i].startsWith('--port=')) {
    const p = parseInt(cliArgs[i].split('=')[1], 10);
    if (isNaN(p) || p < 1 || p > 65535) {
      console.error('Invalid port number:', cliArgs[i].split('=')[1]);
      process.exit(1);
    }
    HTTP_PORT = p;
  } else if (cliArgs[i].startsWith('--agent=')) {
    const name = cliArgs[i].split('=')[1];
    if (!AGENT_MAP[name]) {
      console.error('Unknown agent:', name, '(supported: ' + Object.keys(AGENT_MAP).join(', ') + ')');
      process.exit(1);
    }
    AGENT_BIN = AGENT_MAP[name];
  } else if (cliArgs[i].startsWith('--auth=')) {
    AUTH_TOKEN = cliArgs[i].split('=')[1];
  } else if (cliArgs[i].startsWith('--args=')) {
    AGENT_ARGS = cliArgs[i].split('=')[1].split(' ').filter(Boolean);
  }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const CERT_DIR = path.join(os.homedir(), '.config', 'agent-web-bridge');

function ensureCert() {
  if (!USE_HTTPS) return;
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');
  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) return;

  fs.mkdirSync(CERT_DIR, { recursive: true });
  const subj = os.platform() === 'win32'
    ? `//CN=${HTTP_HOST === '0.0.0.0' ? 'localhost' : HTTP_HOST}`
    : `/CN=${HTTP_HOST === '0.0.0.0' ? 'localhost' : HTTP_HOST}`;
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048',
      '-keyout', keyFile, '-out', certFile,
      '-days', '365', '-nodes',
      '-subj', subj,
    ], { stdio: 'pipe' });
    console.log('[tls] Self-signed certificate generated in', CERT_DIR);
  } catch (err) {
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
const ptyBuffer = [];        // circular buffer of PTY output chunks
const PTY_BUF_MAX = 100000;  // keep last ~100KB
let ptyBufferTotal = 0;

function pushPtyBuffer(data) {
  ptyBuffer.push(data);
  ptyBufferTotal += data.length;
  while (ptyBufferTotal > PTY_BUF_MAX && ptyBuffer.length > 0) {
    const oldest = ptyBuffer.shift();
    ptyBufferTotal -= oldest.length;
  }
}

function getPtyBuffer() {
  return ptyBuffer.join('');
}

function broadcastToWeb(data) {
  pushPtyBuffer(data);
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

wss.on('connection', (ws, req) => {
  if (AUTH_TOKEN) {
    const params = new URL(req.url, 'http://localhost').searchParams;
    if (params.get('token') !== AUTH_TOKEN) {
      ws.close(4001, 'Unauthorized');
      return;
    }
  }
  wsClients.add(ws);
  // Send buffered PTY output to newly connecting client
  if (ptyBufferTotal > 0) {
    const buf = getPtyBuffer();
    if (buf) {
      try {
        ws.send(JSON.stringify({ type: 'data', data: buf }));
      } catch (_) {}
    }
  }

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

  let bin = AGENT_BIN;
  let args = AGENT_ARGS;

  if (os.platform() === 'win32') {
    const ext = path.extname(bin).toLowerCase();
    if (!ext || ext === '.cmd' || ext === '.bat') {
      bin = 'cmd.exe';
      args = ['/c', AGENT_BIN, ...AGENT_ARGS];
    }
  }

  try {
    ptyProcess = spawn(bin, args, {
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
