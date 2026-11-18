const { parseArgs } = require("node:util");
const { subscribe, inspect, worker } = require("./watch.cjs");
async function main() {
  const [op, ...args] = process.argv.slice(2);
  if (op === "hook") {
    let input;
    try {
      input = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    } catch {
      return;
    }
    return require("./hooks.cjs").hook(args[0], args[1], input);
  }
  if (op === "worker") return worker();
  const options = Object.fromEntries(
    [
      "cwd",
      "project",
      "artifact",
      "thread",
      "base-dir",
      "ttl",
      "host",
      "prompt",
      "session-id",
      "command",
    ].map((k) => [k, { type: "string" }]),
  );
  const { values } = parseArgs({ args, options });
  if (op === "observe-command") return require("./hooks.cjs").observeCommand(values);
  if (["session-start", "turn-end", "selection-context"].includes(op)) {
    const output = await require("./lifecycle.cjs").lifecycle(op, values);
    if (output) console.log(output);
    return;
  }
  let result;
  if (op === "subscribe") {
    const { project, artifact, thread, createdAt, deadline } = subscribe(values);
    result = { project, artifact, thread, createdAt, deadline };
  } else if (["status", "list", "unsubscribe", "prune"].includes(op)) result = inspect(op, values);
  else throw Error("Expected subscribe, unsubscribe, status, list or prune");
  console.log(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
