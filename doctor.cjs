// Checks that the installed Ryugi plugin still offers what the bridge borrows from it.
// Loads nothing eagerly so a broken plugin is reported, not thrown.
const fs = require("node:fs");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { locked, label, launch } = require("./store.cjs");
const { call, show } = require("./t3.cjs");
const plugin = require("./plugin.cjs");
const appDir = path.join(plugin, "skills/artifacts/app");
const modules = ["comment-subscriptions", "comment-watch", "agent-event"];
const needs = {
  "comment-subscriptions": ["projectRoot", "aliveFile", "beat", "subscriptionFile", "checkouts"],
  "comment-watch": ["createCommentWatch", "unreadCount", "wakeMessage"],
  "agent-event": ["postToServer"],
};
function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(plugin, "package.json"), "utf8")).version || null;
  } catch {
    return null;
  }
}
// Changes whenever an upgrade replaces any file the bridge loads.
function fingerprint() {
  const files = ["package.json", ...[...modules, "comment-threads", "ryugi"].map((n) => `skills/artifacts/app/${n}.cjs`), "hooks/selection-context.cjs"];
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
    fs.accessSync(path.join(appDir, "ryugi.cjs"));
  });
  check("接口", () => {
    const missing = modules.flatMap((m) => {
      const exported = require(path.join(appDir, m + ".cjs"));
      return needs[m].filter((n) => typeof exported[n] !== "function").map((n) => `${m}.${n}`);
    });
    if (missing.length) throw new Error("缺少 " + missing.join("、"));
  });
  check("订阅文件路径", () => {
    const { subscriptionFile, aliveFile } = require(path.join(appDir, "comment-subscriptions.cjs"));
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
  const notice = `ryugi-t3-watch 已暂停转发 Ryugi 反馈：Ryugi ${report.version || "?"} 未通过兼容自检（${failures(report)}）。请告诉用户运行 \`ryugi-t3-watch doctor\` 查看。修好或回退 Ryugi 后自动恢复；暂停期间的提交不会补发，恢复后需要用户重新提交。`;
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
