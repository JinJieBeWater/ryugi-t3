const { parseArgs } = require("node:util");
const { subscribe, inspect, worker } = require("./watch.cjs");
async function main() {
  const [op, ...args] = process.argv.slice(2);
  if (op === "worker") return worker();
  const options = Object.fromEntries(
    ["cwd", "project", "artifact", "thread", "base-dir", "ttl", "host", "prompt"].map((k) => [
      k,
      { type: "string" },
    ]),
  );
  const { values } = parseArgs({ args, options });
  if (op === "selection-context") {
    const output = require("./selection.cjs").selectionContext(values);
    if (output) console.log(output);
    return;
  }
  let result;
  if (op === "subscribe") {
    const { project, artifact, thread, createdAt, deadline } = subscribe(values);
    result = { project, artifact, thread, createdAt, deadline };
  } else if (["status", "list", "unsubscribe", "prune"].includes(op)) result = inspect(op, values);
  else throw Error("Expected subscribe, selection-context, unsubscribe, status, list or prune");
  console.log(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
