const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const transport = () => ({
  base: path.resolve(process.env.T3CODE_HOME || path.join(os.homedir(), ".t3")),
  t3: process.env.T3CODE_CLI_PATH || path.join(os.homedir(), ".t3/bin/t3"),
});
function call(record, op, ...args) {
  const out = execFileSync(
    record.t3,
    ["thread", op, "--base-dir", record.base, "--json", ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  return JSON.parse(out);
}
function show(r, n) {
  const detail = call(r, "show", "--messages", String(n), r.thread);
  if (detail.thread?.threadId !== r.thread) throw new Error("T3 returned a different thread");
  return detail;
}
module.exports = { transport, call, show };
