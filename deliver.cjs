// Ryugi custom-host delivery command (Ryugi 1.102.8+): reads one event on stdin and sends its wake message
// to the T3 thread named by `session`. Exit 0 = delivered, 10 = thread gone (Ryugi unsubscribes), else retry.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const UNSUBSCRIBE = 10;
const t3 = process.env.T3CODE_CLI_PATH || path.join(os.homedir(), ".t3/bin/t3");
const base = path.resolve(process.env.T3CODE_HOME || path.join(os.homedir(), ".t3"));
const call = (op, args, input) =>
  JSON.parse(
    execFileSync(t3, ["thread", op, "--base-dir", base, "--json", ...args], {
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 10000,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
    }),
  );
const failure = (e) => String(e.stderr || e.message);

const { session, wakeMessage } = JSON.parse(fs.readFileSync(0, "utf8"));
// Thread state, or null when T3 no longer has the thread; any other failure is left to Ryugi's retry.
function thread(messages) {
  try {
    return call("show", ["--messages", String(messages), session]);
  } catch (e) {
    if (/is no longer available/.test(failure(e))) return null;
    throw e;
  }
}

try {
  const before = thread(1);
  if (!before || before.thread.archived) process.exit(UNSUBSCRIBE);
  try {
    const ack = call("send", [session, "-"], wakeMessage);
    if (ack.threadId !== session || !ack.messageId || !["started", "queued"].includes(ack.delivery))
      throw Error("T3 returned no receipt");
    console.log(JSON.stringify({ status: ack.delivery }));
  } catch (e) {
    // A send that timed out may still have landed; resending it would show the same feedback twice.
    const last = thread(5)?.messages.findLast((m) => m.role === "user");
    if (last?.text !== wakeMessage) throw e;
    console.log(JSON.stringify({ status: "delivered" }));
  }
} catch (e) {
  process.stderr.write(failure(e).trim() + "\n");
  process.exit(1);
}
