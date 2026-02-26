#!/usr/bin/env node

// Synchronous hook for tool approval.
// When approval mode is OFF on the server, /approval/request returns
// { status: "auto_approved" } immediately and we exit(0) with no stdout
// (Claude Code proceeds normally).
// When ON, we poll /approval/response/:id until a decision arrives,
// then output { hookSpecificOutput: { permissionDecision } } on stdout.

const http = require('http');

const PORT = parseInt(process.env.AGENT_VIZ_PORT || '1217', 10);
const POLL_INTERVAL_MS = 500;
const TIMEOUT_MS = 60_000;

// Read all stdin
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });

process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(raw);
  } catch (_) {
    process.exit(0); // Can't parse → fail-open
  }

  const body = JSON.stringify({
    toolName: data.tool_name || '',
    toolInput: data.tool_input || {},
    sessionId: data.session_id || '',
  });

  const req = http.request({
    hostname: '127.0.0.1',
    port: PORT,
    path: '/approval/request',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    timeout: 3000,
  }, (res) => {
    let resBody = '';
    res.on('data', (chunk) => { resBody += chunk; });
    res.on('end', () => {
      try {
        const result = JSON.parse(resBody);
        if (result.status === 'auto_approved') {
          // Approval mode OFF → no stdout, exit cleanly
          process.exit(0);
        }
        if (result.status === 'pending' && result.requestId) {
          pollForDecision(result.requestId);
        } else {
          process.exit(0); // Unexpected → fail-open
        }
      } catch (_) {
        process.exit(0);
      }
    });
  });

  req.on('error', () => { process.exit(0); }); // Server unreachable → fail-open
  req.on('timeout', () => { req.destroy(); process.exit(0); });
  req.write(body);
  req.end();
});

process.stdin.on('error', () => { process.exit(0); });

function pollForDecision(requestId) {
  const startTime = Date.now();

  function poll() {
    if (Date.now() - startTime > TIMEOUT_MS) {
      // Timeout → fall back to terminal prompt
      const output = JSON.stringify({ hookSpecificOutput: { permissionDecision: 'ask' } });
      process.stdout.write(output + '\n');
      process.exit(0);
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: `/approval/response/${requestId}`,
      method: 'GET',
      timeout: 3000,
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (result.status === 'decided') {
            const decision = result.decision === 'deny' ? 'deny' : 'allow';
            const output = JSON.stringify({ hookSpecificOutput: { permissionDecision: decision } });
            process.stdout.write(output + '\n');
            process.exit(0);
          }
          // Still pending → poll again
          setTimeout(poll, POLL_INTERVAL_MS);
        } catch (_) {
          setTimeout(poll, POLL_INTERVAL_MS);
        }
      });
    });

    req.on('error', () => { setTimeout(poll, POLL_INTERVAL_MS); });
    req.on('timeout', () => { req.destroy(); setTimeout(poll, POLL_INTERVAL_MS); });
    req.end();
  }

  poll();
}
