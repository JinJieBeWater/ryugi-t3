const { parseArgs } = require("node:util");
const { doctor, format, fingerprint, paused } = require("./doctor.cjs");
async function main() {
  const [op, ...args] = process.argv.slice(2);
  if (op === "doctor") {
    const report = doctor();
    console.log(format(report));
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (op === "install") {
    const entry = require("./entry.cjs");
    console.log(`已写入 ${entry.install()}
T3 设置里 Codex、Pi、Antigravity 的 providerInstances.<id>.environment 设 NODE_OPTIONS=${entry.nodeOptions()}
Claude 的 config.launchArgs 设 --settings ${require("node:path").join(__dirname, "claude-settings.json")}`);
    return;
  }
  if (op === "worker") {
    const print = fingerprint(),
      report = doctor();
    if (!report.ok) return paused(report, print);
    return require("./watch.cjs").worker(print);
  }
  const options = Object.fromEntries(
    ["cwd", "project", "artifact", "thread", "base-dir", "ttl", "launcher", "ryugi-session"].map((k) => [
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
    const report = doctor();
    if (!report.ok)
      throw Error("Ryugi 插件未通过兼容自检，没有订阅。告诉用户这一点和下面的结果：\n" + format(report));
    const { project, artifact, thread, createdAt, deadline } = require("./watch.cjs").subscribe(values);
    result = { project, artifact, thread, createdAt, deadline };
  } else if (["status", "list", "unsubscribe"].includes(op))
    result = require("./watch.cjs").inspect(op, values);
  else throw Error("Expected install, subscribe, doctor, selection-context, unsubscribe, status or list");
  console.log(JSON.stringify(result));
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
