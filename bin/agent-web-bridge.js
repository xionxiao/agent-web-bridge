#!/usr/bin/env node

const path = require('path');

const AGENT_MAP = {
  'claude':    'claude',
  'opencode':  'opencode',
  'codex':     'codex',
  'kiro':      'kiro-cli',
  'kiro-cli':  'kiro-cli',
};

function printHelp() {
  const agents = Object.keys(AGENT_MAP).join(', ');
  /* eslint-disable no-console */
  console.log(`
agent-web-bridge — bridge a local agent CLI session to the browser.

USAGE
  agent-web-bridge [options]

OPTIONS
  -h, --help            Show this help message and exit.
      --port=<port>     HTTP/WebSocket port (default: 3001, or $PORT).
      --https           Enable HTTPS with a self-signed certificate.
      --agent=<name>    Agent to launch. Supported: ${agents}.
                        Default: claude.
      --args="<...>"    Extra arguments forwarded to the agent, space-separated.

ENVIRONMENT
  PORT          Overrides the default port (same as --port).
  HTTPS         Set to "true" to enable HTTPS (same as --https).

EXAMPLES
  agent-web-bridge
  agent-web-bridge --port=4000 --agent=opencode
  agent-web-bridge --agent=codex --args="--model gpt-5"
  PORT=4000 agent-web-bridge
`.trim());
}

const cliArgs = process.argv.slice(2);
let port = process.env.PORT || 3001;
let agentBin = null;
let agentArgs = [];
let httpsMode = false;

for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === '--help' || cliArgs[i] === '-h') {
    printHelp();
    process.exit(0);
  } else if (cliArgs[i] === '--https') {
    httpsMode = true;
  } else if (cliArgs[i] === '--port' && cliArgs[i + 1]) {
    port = parseInt(cliArgs[i + 1], 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port number:', cliArgs[i + 1]);
      process.exit(1);
    }
    i++;
  } else if (cliArgs[i].startsWith('--agent=')) {
    const name = cliArgs[i].split('=')[1];
    if (!AGENT_MAP[name]) {
      console.error('Unknown agent:', name, '(supported: ' + Object.keys(AGENT_MAP).join(', ') + ')');
      process.exit(1);
    }
    agentBin = AGENT_MAP[name];
  } else if (cliArgs[i].startsWith('--args=')) {
    agentArgs = cliArgs[i].split('=')[1].split(' ').filter(Boolean);
  }
}

process.env.PORT = String(port);
if (httpsMode) process.env.HTTPS = 'true';
if (agentBin) process.env.CLAUDE_BIN = agentBin;
if (agentArgs.length) process.env.AGENT_ARGS = JSON.stringify(agentArgs);
require(path.join(__dirname, '..', 'server.js'));
