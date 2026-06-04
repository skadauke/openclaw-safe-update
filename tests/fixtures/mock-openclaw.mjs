#!/usr/bin/env node
// Mock openclaw CLI for hermetic CI testing.
// Mimics the CLI surface exercised by the smoketest suite.
//
// MOCK_FAIL_MODE env controls --fail gateway behavior:
//   healthz   → /healthz returns {"ok":false}
//   crash     → process exits immediately before binding
//   fatal-log → /healthz returns HTTP 500, writes fatal lines to stderr

import { createServer } from 'node:http';

const args = process.argv.slice(2);

if (args[0] === '--version') {
  process.stdout.write('mock-openclaw 2026.1.1\n');
  process.exit(0);
} else if (args[0] === 'gateway' && args[1] === 'run') {
  const portIdx = args.indexOf('--port');
  const port = portIdx !== -1 ? parseInt(args[portIdx + 1], 10) : 18789;
  const hasFail = args.includes('--fail');
  const failMode = process.env.MOCK_FAIL_MODE || (hasFail ? 'healthz' : '');

  if (failMode === 'crash') {
    process.stderr.write('mock gateway: crash mode — exiting immediately\n');
    process.exit(1);
  }

  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/healthz') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (failMode === 'fatal-log') {
      process.stderr.write('[FATAL] mock gateway: startup failed — fatal error\n');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, status: 'fatal' }));
    } else if (failMode === 'healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, status: 'unhealthy' }));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, status: 'live' }));
    }
  });

  server.on('error', err => {
    process.stderr.write(`mock gateway server error: ${err.message}\n`);
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    process.stderr.write(`mock gateway listening on 127.0.0.1:${port}\n`);
  });

  process.on('SIGTERM', () => { server.close(); process.exit(0); });
  process.on('SIGINT', () => { server.close(); process.exit(0); });
  // Keep process alive — HTTP server holds the event loop open.
} else if (args[0] === 'mcp' && args[1] === 'list') {
  const servers = [
    { name: 'filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'] },
    { name: 'memory', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] },
    { name: 'mock-tools', transport: 'stdio', command: 'node', args: ['mock-mcp-server.mjs'] },
  ];
  process.stdout.write(JSON.stringify(servers, null, 2) + '\n');
  process.exit(0);
} else if (args[0] === 'skills' && args[1] === 'list') {
  // ≥10 skills, includes all five 'current'-mode EXPECTED skills:
  // calendar, gog, github, book-and-reserve, online-shop
  const skills = [
    { name: 'calendar',         version: '1.0.0', bundled: true },
    { name: 'gog',              version: '1.0.0', bundled: true },
    { name: 'github',           version: '1.0.0', bundled: true },
    { name: 'book-and-reserve', version: '1.0.0', bundled: true },
    { name: 'online-shop',      version: '1.0.0', bundled: true },
    { name: 'web-search',       version: '1.0.0', bundled: true },
    { name: 'calculator',       version: '1.0.0', bundled: true },
    { name: 'file-manager',     version: '1.0.0', bundled: true },
    { name: 'email',            version: '1.0.0', bundled: true },
    { name: 'notes',            version: '1.0.0', bundled: true },
    { name: 'weather',          version: '1.0.0', bundled: true },
  ];
  process.stdout.write(JSON.stringify({ skills }, null, 2) + '\n');
  process.exit(0);
} else if (args[0] === 'doctor') {
  if (args.includes('--lint') && args.includes('--json')) {
    process.stdout.write(JSON.stringify({ findings: [] }, null, 2) + '\n');
    process.exit(0);
  } else if (args.includes('--repair') && args.includes('--non-interactive')) {
    process.exit(0);
  } else {
    // Plain `doctor` (test #11): print output with no missing-deps block.
    process.stdout.write('OpenClaw Doctor\nAll checks passed — no issues found.\n');
    process.exit(0);
  }
} else {
  process.stderr.write(`mock-openclaw: unrecognized command: ${args.join(' ')}\n`);
  process.exit(1);
}
