// Checks that the installed Ryugi plugin still offers what the bridge borrows from it.
// Loads nothing eagerly so a broken plugin is reported, not thrown.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: sleep } = require("node:timers/promises");
const { locked, label, launch } = require("./store.cjs");
const { call, show } = require("./t3.cjs");
const plugin = require("./plugin.cjs");
const appDir = path.join(plugin, "skills/artifacts/app");
const modules = ["comment-subscriptions", "comment-watch", "comment-threads", "agent-event"];
const needs = {
  "comment-subscriptions": ["projectRoot", "aliveFile", "beat", "subscriptionFile", "checkouts"],
  "comment-watch": ["createCommentWatch", "unreadCount", "wakeMessage"],
  "comment-threads": ["humanTokens"],
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
  const files = ["package.json", ...[...modules, "ryugi"].map((n) => `skills/artifacts/app/${n}.cjs`)];
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
const put = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};
// Feeds one synthetic project to Ryugi's own watcher and to the bridge; their messages must match.
function parity() {
  const { createCommentWatch, wakeMessage } = require(path.join(appDir, "comment-watch.cjs"));
  const { scan, emptyBaseline } = require("./events.cjs");
  const project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ryugi-t3-doctor-")));
  try {
    const root = path.join(project, ".ryugi/artifacts"),
      a = "artboard/doctor",
      d = "document/doctor";
    const rounds = (state) =>
      put(path.join(root, ".state", a, "rounds.json"), { rounds: [{ id: "r", state, groups: ["g"] }] });
    put(path.join(root, a, "comments.json"), { threads: [] });
    put(path.join(root, d, "comments.json"), { threads: [] });
    rounds("open");
    const native = createCommentWatch(project, "pi"),
      set = new Set([a, d]),
      ba = emptyBaseline(),
      bd = emptyBaseline();
    native(set);
    scan(project, a, "pi", ba, true);
    scan(project, d, "pi", bd, true);
    rounds("submitted");
    put(path.join(root, ".state", d, "asks.json"), { latest: { id: "s1" } });
    const human = { id: "m", at: "2026-01-01", author: "human", text: "doctor" };
    put(path.join(root, d, "comments.json"), {
      threads: [{ id: "t", anchor: {}, status: "open", messages: [human] }],
    });
    const expected = native(set);
    const ours = [...scan(project, a, "pi", ba), ...scan(project, d, "pi", bd)];
    const kinds = ["choices", "answers", "comments"];
    for (const kind of kinds) {
      const theirs = expected.filter((e) => e.type === "ryugi-" + kind),
        mine = ours.filter((e) => e.kind === kind);
      if (theirs.length !== 1 || mine.length !== 1)
        throw new Error(`${kind}：Ryugi ${theirs.length} 条，桥接 ${mine.length} 条`);
      if (wakeMessage(theirs[0], 500) !== mine[0].text) throw new Error(kind + " 的提醒文本不同");
      if (JSON.stringify(theirs[0].argv) !== JSON.stringify(mine[0].render?.argv))
        throw new Error(kind + " 的内联命令参数不同");
    }
    return kinds.join("、") + " 与 Ryugi 原生 watcher 一致";
  } finally {
    fs.rmSync(project, { recursive: true, force: true });
  }
}
function doctor() {
  const checks = [];
  const check = (name, fn) => {
    try {
      checks.push({ name, ok: true, detail: fn() || "" });
    } catch (e) {
      checks.push({ name, ok: false, detail: e.message.split("\n")[0] });
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
  check("事件对照", parity);
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
  return { ok: checks.every((c) => c.ok), version: version(), plugin, checks };
}
const format = (report) =>
  [
    `Ryugi ${report.version || "?"}（${report.plugin}）`,
    ...report.checks.map((c) => `${c.ok ? "✔" : "✖"} ${c.name}${c.detail ? "：" + c.detail : ""}`),
  ].join("\n");
const failures = (report) =>
  report.checks
    .filter((c) => !c.ok)
    .map((c) => c.name + "：" + c.detail)
    .join("；");
// A worker on a failing plugin delivers nothing, so feedback waits in Ryugi's files with the baseline.
// It tells each subscribed thread once, then restarts under launchd when the plugin changes again.
async function paused(report, print) {
  const notice = `ryugi-t3-watch 已暂停转发 Ryugi 反馈：Ryugi ${report.version || "?"} 未通过兼容自检（${failures(report)}）。请告诉用户运行 \`ryugi-t3-watch doctor\` 查看。修好或回退 Ryugi 后自动恢复，期间的反馈不会丢。`;
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
