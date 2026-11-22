// Checks that the installed Ryugi plugin still offers what the bridge borrows from it.
// Loads nothing eagerly so a broken plugin is reported, not thrown.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { locked, label, launch } = require("./store.cjs");
const { call, show } = require("./t3.cjs");
const upstream = require("./upstream.cjs");
const { plugin, launcher, contract, reminderHelpers, load } = upstream;
function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}
// Changes whenever an upgrade replaces any file the bridge loads.
function fingerprint() {
  const files = ["package.json", path.relative(plugin, launcher), ...Object.keys(contract)];
  return files
    .map((f) => {
      try {
        const s = fs.statSync(path.join(plugin, f));
        return `${f}:${s.size}:${s.mtimeMs}`;
      } catch {
        return f + ":missing";
      }
    })
    .join("|");
}
function doctor() {
  const checks = [];
  // A soft check only warns: it does not pause forwarding.
  const check = (name, fn, soft = false) => {
    try {
      checks.push({ name, ok: true, detail: fn() || "" });
    } catch (e) {
      checks.push({ name, ok: false, soft, detail: e.message.split("\n")[0] });
    }
  };
  check("插件", () => {
    if (!version()) throw new Error("找不到 " + path.join(plugin, "package.json"));
  });
  check("启动器", () => {
    fs.accessSync(launcher);
  });
  check("接口", () => {
    const missing = Object.entries(contract).flatMap(([file, names]) => {
      let exported;
      try {
        exported = load(file);
      } catch {
        return [file];
      }
      const name = path.basename(file, ".cjs");
      return names.filter((n) => typeof exported[n] !== "function").map((n) => `${name}.${n}`);
    });
    if (missing.length) throw new Error("缺少 " + missing.join("、"));
    // The selection hook also has to run as selection-context runs it.
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryugi-t3-doctor-")));
    try {
      fs.mkdirSync(path.join(project, ".ryugi/artifacts"), { recursive: true });
      require("./selection.cjs").selectionContext({ cwd: project });
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
  // Ryugi's watcher must still report a submit and an answer as events the bridge forwards with a brief.
  check("事件", () => {
    const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryugi-t3-doctor-")));
    const put = (file, value) => {
      fs.mkdirSync(path.dirname(path.join(project, file)), { recursive: true });
      fs.writeFileSync(path.join(project, file), JSON.stringify(value));
    };
    try {
      const a = "artboard/doctor",
        d = "document/doctor",
        rounds = (state) => put(`.ryugi/artifacts/.state/${a}/rounds.json`, { rounds: [{ id: "r", state }] });
      for (const id of [a, d]) put(`.ryugi/artifacts/${id}/comments.json`, { threads: [] });
      rounds("open");
      const poll = upstream.createCommentWatch(project),
        set = new Set([a, d]);
      poll(set);
      rounds("submitted");
      put(`.ryugi/artifacts/.state/${d}/asks.json`, { latest: { id: "s" } });
      const { message } = require("./events.cjs");
      const kinds = poll(set)
        .map((e) => message(e, { project }, "pi"))
        .filter((m) => m?.render)
        .map((m) => m.kind);
      const missing = ["choices", "answers"].filter((k) => kinds.filter((x) => x === k).length !== 1);
      if (missing.length) throw new Error(`提交后没有可转发的 ${missing.join("、")} 事件`);
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  });
  check(
    "选区提醒",
    () => {
      const exported = load("hooks/selection-context.cjs");
      const missing = reminderHelpers.filter((n) => typeof exported[n] !== "function");
      if (missing.length) throw new Error(`缺少 ${missing.join("、")}，selection-context 会带上未读评论提醒`);
    },
    true,
  );
  check("订阅文件路径", () => {
    const { subscriptionFile, aliveFile } = upstream;
    const dir = path.join("/p", ".ryugi/artifacts/.state/codex-comment-watch");
    if (subscriptionFile("/p", "codex", "s") !== path.join(dir, "s.json"))
      throw new Error("subscriptionFile 返回 " + subscriptionFile("/p", "codex", "s"));
    if (aliveFile("/p", "codex", "s") !== path.join(dir, "s.alive"))
      throw new Error("aliveFile 返回 " + aliveFile("/p", "codex", "s"));
  });
  // Entry points only decide whether start auto-subscribes; forwarding works without them.
  check("入口", () => require("./entry.cjs").entries(), true);
  check("内联摘要", () => {
    const { render } = require("./events.cjs");
    const text = render({
      type: "ryugi-choices",
      artifact: "artboard/doctor",
      round: "r",
      groups: 1,
      command: "x",
      argv: ["-e", "console.log('RTW-DOCTOR')"],
    });
    if (!text.endsWith("\nRTW-DOCTOR")) throw new Error("wakeMessage 没有内联提交摘要");
  });
  return { ok: checks.every((c) => c.ok || c.soft), version: version(), plugin, checks };
}
const format = (report) =>
  [
    `Ryugi ${report.version || "?"}（${report.plugin}）`,
    ...report.checks.map((c) => `${c.ok ? "✔" : c.soft ? "⚠" : "✖"} ${c.name}${c.detail ? "：" + c.detail : ""}`),
  ].join("\n");
const failures = (report) =>
  report.checks
    .filter((c) => !c.ok && !c.soft)
    .map((c) => c.name + "：" + c.detail)
    .join("；");
// A worker on a failing plugin detects and delivers nothing. It tells each subscribed thread once, then restarts under launchd when the plugin changes again.
async function paused(report, print) {
  const notice = `ryugi-t3 已暂停转发 Ryugi 反馈：Ryugi ${report.version || "?"} 未通过兼容自检（${failures(report)}）。请告诉用户运行 \`ryugi-t3 doctor\` 查看。修好或回退 Ryugi 后自动恢复；暂停期间的提交不会补发，恢复后需要用户重新提交。`;
  const key = print + "\n" + failures(report);
  const route = (r) => JSON.stringify([r.base, r.thread]);
  // Records the outcome on every subscription of that thread, so a thread gets one notice.
  const mark = (target, fields) =>
    locked((db, save) => {
      for (const r of db.subscriptions) if (route(r) === route(target)) Object.assign(r, fields);
      save();
    });
  while (true) {
    if (fingerprint() !== print) process.exit(75);
    const targets = locked((db) => {
      const now = Date.now(),
        active = db.subscriptions.filter((r) => r.deadline > now);
      if (!active.length) {
        launch("remove", label);
        return null;
      }
      const due = active.filter(
        (r) => r.notice !== key && !(r.noticeTry?.key === key && r.noticeTry.at > now),
      );
      return [...new Map(due.map((r) => [route(r), r])).values()];
    });
    if (!targets) return;
    for (const r of targets) {
      try {
        // A send without a receipt may still have landed; the thread decides before resending.
        if (
          r.noticeTry?.key === key &&
          show(r, 50).messages.some((m) => m.role === "user" && m.text === notice)
        ) {
          mark(r, { notice: key, noticeTry: undefined });
          continue;
        }
        mark(r, { noticeTry: { key, at: Date.now() + 5000 } });
        const ack = call(r, "send", r.thread, notice);
        if (ack.threadId === r.thread && ack.messageId)
          mark(r, { notice: key, noticeTry: undefined });
      } catch {
        // Retried after noticeTry.at.
      }
    }
    await sleep(2000);
  }
}
module.exports = { doctor, format, fingerprint, paused, plugin };
