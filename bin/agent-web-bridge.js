#!/usr/bin/env node

const path = require('path');

const AGENT_MAP = {
  'claude':    'claude',
  'opencode':  'opencode',
  'codex':     'codex',
  'kiro':      'kiro-cli',
  'kiro-cli':  'kiro-cli',
};

const cliArgs = process.argv.slice(2);
let port = process.env.PORT || 3001;
let agentBin = null;
let agentArgs = [];

for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === '--port' && cliArgs[i + 1]) {
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
if (agentBin) process.env.CLAUDE_BIN = agentBin;
if (agentArgs.length) process.env.AGENT_ARGS = JSON.stringify(agentArgs);
require(path.join(__dirname, '..', 'server.js'));
