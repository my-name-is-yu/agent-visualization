#!/usr/bin/env node

const http = require("http");

// Parse --phase argument, default to "post"
let phase = "post";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--phase" && args[i + 1]) {
    phase = args[i + 1];
    break;
  }
}

const PORT = parseInt(process.env.AGENT_VIZ_PORT || "1217", 10);

// Read all stdin
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});

process.stdin.on("end", () => {
  // Exit after 1000ms max, no matter what
  const timeout = setTimeout(() => {
    process.exit(0);
  }, 1000);
  timeout.unref();

  try {
    const data = JSON.parse(raw);
    data.hook_phase = phase;
    const body = JSON.stringify(data);
    sendRequest(body, (err) => {
      if (err) {
        process.stderr.write(`[hook] Retry after error: ${err.message}\n`);
        sendRequest(body, (retryErr) => {
          if (retryErr) {
            process.stderr.write(`[hook] Retry failed: ${retryErr.message}\n`);
          }
          process.exit(0);
        });
      } else {
        process.exit(0);
      }
    });
  } catch (e) {
    process.stderr.write(`[hook] JSON parse error: ${e.message}\n`);
    process.exit(0);
  }
});

process.stdin.on("error", () => {
  process.exit(0);
});

function sendRequest(body, cb) {
  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: PORT,
      path: "/event",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: 500,
    },
    (res) => {
      res.resume();
      res.on("end", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cb(null);
        } else {
          cb(new Error(`HTTP ${res.statusCode}`));
        }
      });
    }
  );

  req.on("error", (err) => cb(err));
  req.on("timeout", () => {
    req.destroy(new Error("timeout"));
  });

  req.write(body);
  req.end();
}
