const fs = require("node:fs");
const path = require("node:path");
const { app, plugin } = require("./upstream.cjs");
const { unreadCount, wakeMessage } = app("comment-watch");

function read(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}
const emptyBaseline = () => ({
  roundStates: {},
  asksLatest: null,
  notifiedSubmits: {},
});
const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
const sections = {
  choices: ["groups", "--kind", "choose"],
  answers: ["asks", "--status", "submitted"],
  comments: ["threads"],
};
// Same argv Ryugi's own watcher builds for its inline submit brief.
const listArgv = (project, artifact, kind) => [
  path.join(plugin, "skills/artifacts/app/ryugi.cjs"),
  "comment",
  "list",
  "--section",
  ...sections[kind],
  "--detail",
  "--format",
  "brief",
  "--project-dir",
  project,
  "--artifact",
  artifact,
];
// Runs Ryugi's list command for up to 15 s; a failed read keeps the Run command.
// A submit also brings the comments still unread when it renders, in Ryugi's own comments format.
// The worker runs outside any agent, so Ryugi's CLI is told whose unread comments to list
// (AI_AGENT wins over its environment sniffing).
const agents = { "Claude Code": "claude", Codex: "codex", Antigravity: "antigravity", pi: "pi", Grok: "grok" };
function render(event) {
  const f = event.followUp;
  const before = process.env.AI_AGENT;
  if (agents[f?.host]) process.env.AI_AGENT = agents[f.host];
  const rebind = (text) => {
    const r = event.rebind;
    if (!r) return text;
    const from = r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return text.replace(new RegExp(`(["']?)${from}\\1`, "g"), () => r.to);
  };
  try {
    const text = wakeMessage(event, Infinity);
    const unread = f ? unreadCount(f.project, event.artifact, f.host) : 0;
    if (!unread) return rebind(text);
    const comments = { type: "ryugi-comments", artifact: event.artifact, unread, command: f.command, argv: f.argv };
    return rebind(text + "\n\n" + wakeMessage(comments, Infinity));
  } finally {
    if (before === undefined) delete process.env.AI_AGENT;
    else process.env.AI_AGENT = before;
  }
}

// opts.launcher and opts.proof are the launcher the agent ran start with, so the Run line it is
// shown works in its host (Codex binds commands to --ryugi-session). The bridge itself reads with argv.
function scan(project, artifact, host, baseline, initial = false, opts = {}) {
  const root = path.join(project, ".ryugi/artifacts");
  const state = path.join(root, ".state", artifact);
  const file = read(path.join(root, artifact, "comments.json"));
  const threads = file?.threads ?? [];
  const messages = [];
  // Left over from when comments were sent on their own.
  delete baseline.seenComments;
  const commandFor = (argv) => {
    const shown = [opts.launcher || argv[0], ...(opts.proof ? ["--ryugi-session", opts.proof] : []), ...argv.slice(1)];
    const paths = new Set([shown[0], project]);
    return ["node", ...shown].map((x) => (paths.has(x) ? quote(x) : x)).join(" ");
  };
  function emit(kind, fields) {
    if (initial) return;
    const argv = listArgv(project, artifact, kind);
    const event = { type: "ryugi-" + kind, artifact, command: commandFor(argv), ...fields };
    const message = { kind, text: wakeMessage(event, 500) };
    // T3 has no length cap, so a submit gets its brief inline once rendered outside the store lock.
    // Comments are not sent on their own; a submit carries whatever is still unread.
    if (!fields.withdrawn) {
      const threadsArgv = listArgv(project, artifact, "comments");
      message.render = {
        ...event,
        argv,
        followUp: { project, host, argv: threadsArgv, command: commandFor(threadsArgv) },
        // The brief's Check/Reply/Resolve lines name the bridge's launcher; the agent gets its own.
        ...(opts.launcher && {
          rebind: {
            from: argv[0],
            to: quote(opts.launcher) + (opts.proof ? " --ryugi-session " + opts.proof : ""),
          },
        }),
      };
    }
    messages.push(message);
  }
  const rounds = artifact.startsWith("artboard/")
    ? (read(path.join(state, "rounds.json"))?.rounds ?? [])
    : [];
  const submits = new Map(),
    withdrawals = new Map();
  for (const thread of threads) {
    const a = thread.anchor;
    if (!a?.round || typeof a.submit !== "boolean") continue;
    const index = a.submit ? submits : withdrawals;
    if (
      !index.has(a.round) ||
      (thread.messages[0]?.at ?? "") >= (index.get(a.round).messages[0]?.at ?? "")
    )
      index.set(a.round, thread);
  }
  // rounds.json can temporarily be empty while the server rebuilds derived state.
  if (initial) for (const [round, submit] of submits) baseline.notifiedSubmits[round] = submit.id;
  for (const round of rounds) {
    const before = baseline.roundStates[round.id];
    const submit = submits.get(round.id),
      withdrawal = withdrawals.get(round.id);
    const standing =
      submit && (!withdrawal || withdrawal.messages[0]?.at < submit.messages[0]?.at)
        ? submit.id
        : null;
    const submitted = round.state === "submitted";
    if (
      submitted &&
      (standing ? baseline.notifiedSubmits[round.id] !== standing : before !== round.state)
    ) {
      emit("choices", { round: round.id, groups: round.groups?.length ?? 0, submit: submit?.id });
      if (standing) baseline.notifiedSubmits[round.id] = standing;
    } else if (!standing && before === "submitted" && round.state === "open") {
      emit("choices", { round: round.id, withdrawn: true, submit: submit?.id });
    }
    baseline.roundStates[round.id] = round.state;
  }
  if (artifact.startsWith("document/")) {
    const latest = read(path.join(state, "asks.json"))?.latest;
    if (latest?.id) {
      const before = baseline.asksLatest;
      const withdrawn = latest.withdrawn === true;
      if (
        (!withdrawn && before?.id !== latest.id) ||
        (withdrawn && before?.id === latest.id && !before.withdrawn)
      ) {
        const covered = threads.find((t) => t.id === latest.id)?.anchor?.asks;
        const asks = threads
          .map((t) => t.anchor)
          .filter((a) => typeof a?.ask === "string" && a.submit === undefined && a.note !== true);
        emit("answers", {
          submit: latest.id,
          withdrawn,
          questions: covered?.length || new Set(asks.map((a) => a.ask)).size,
        });
      }
      baseline.asksLatest = { id: latest.id, withdrawn };
    }
  }
  return messages;
}
module.exports = { emptyBaseline, scan, render, listArgv };
