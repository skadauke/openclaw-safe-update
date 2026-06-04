#!/usr/bin/env node
// Minimal MCP stdio server for hermetic CI testing.
// Responds to initialize + tools/list over newline-delimited JSON-RPC on stdin/stdout.

import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line.trim()); } catch { return; }
  if (!msg || !msg.method) return;

  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'mock-tools', version: '1.0.0' },
      },
    }) + '\n');
  } else if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          { name: 'mock-echo', description: 'Mock tool for smoketest', inputSchema: { type: 'object', properties: {} } },
        ],
      },
    }) + '\n');
  }
  // notifications/initialized and other notifications need no response
});
