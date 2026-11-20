#!/usr/bin/env node
// Claude Code SessionStart hook, set only for T3 threads through the Claude launch argument
// `--settings <this dir>/claude-settings.json`. Claude strips NODE_OPTIONS from the environment its Bash
// commands inherit but sources CLAUDE_ENV_FILE before each one, so the preload goes there and a
// `ryugi.cjs start` subscribes the same way as under the other providers.
const fs = require("node:fs");
const path = require("node:path");
const preload = path.join(__dirname, "preload.cjs");
const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function exports_(input, env = process.env) {
  if (!env.T3CODE_THREAD_ID) return "";
  const lines = [
    // Node reads double-quoted NODE_OPTIONS values, so a path with spaces still loads.
    // A resumed session sources one env file per SessionStart; add the preload once.
    `case "$NODE_OPTIONS" in *${sq(preload)}*) ;; *)`,
    `export NODE_OPTIONS=${sq("--require " + JSON.stringify(preload))}"\${NODE_OPTIONS:+ $NODE_OPTIONS}" ;; esac`,
  ];
  // Ryugi's own prompt hook shows Claude the selection of the session's project; the preload then
  // leaves its selection hint out for that project.
  try {
    const { projectRoot } = require("./upstream.cjs");
    lines.push(`export RYUGI_T3_SESSION_PROJECT=${sq(projectRoot(input.cwd || env.CLAUDE_PROJECT_DIR || process.cwd()))}`);
  } catch {}
  return lines.join("\n") + "\n";
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let input = {};
    try {
      input = JSON.parse(raw);
    } catch {}
    const text = exports_(input);
    if (text && process.env.CLAUDE_ENV_FILE) fs.appendFileSync(process.env.CLAUDE_ENV_FILE, text);
  });
}
module.exports = { exports: exports_ };
