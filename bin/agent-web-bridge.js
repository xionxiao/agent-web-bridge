#!/usr/bin/env node

const path = require('path');

const args = process.argv.slice(2);
let port = process.env.PORT || 3001;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error('Invalid port number:', args[i + 1]);
      process.exit(1);
    }
    i++;
  }
}

process.env.PORT = String(port);
require(path.join(__dirname, '..', 'server.js'));
