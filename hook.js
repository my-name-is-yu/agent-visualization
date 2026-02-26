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

// Exit after 500ms max, no matter what
const timeout = setTimeout(() => {
  process.exit(0);
}, 500);
timeout.unref();

// Read all stdin
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});

process.stdin.on("end", () => {
  try {
    const data = JSON.parse(raw);
    data.hook_phase = phase;
    const body = JSON.stringify(data);

    const req = http.request(
      {
        hostname: "127.0.0.1",
        port: parseInt(process.env.AGENT_VIZ_PORT || "1217", 10),
        path: "/event",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      () => {
        process.exit(0);
      }
    );

    req.on("error", () => {
      process.exit(0);
    });

    req.write(body);
    req.end();
  } catch (_) {
    process.exit(0);
  }
});

process.stdin.on("error", () => {
  process.exit(0);
});
