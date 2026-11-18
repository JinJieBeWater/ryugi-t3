const fs = require("node:fs");
const path = require("node:path");
const { app, plugin } = require("./upstream.cjs");
const { unreadCount, wakeMessage } = app("comment-watch");
const { humanTokens } = app("comment-threads");

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
  seenComments: {},
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
const render = (event) => wakeMessage(event, Infinity);

function scan(project, artifact, host, baseline, initial = false) {
  const root = path.join(project, ".ryugi/artifacts");
  const state = path.join(root, ".state", artifact);
  const file = read(path.join(root, artifact, "comments.json"));
  const threads = file?.threads ?? [];
  const messages = [];
  function emit(kind, fields) {
    if (initial) return;
    const argv = listArgv(project, artifact, kind);
    const paths = new Set([argv[0], project]);
    const command = ["node", ...argv].map((x) => (paths.has(x) ? quote(x) : x)).join(" ");
    const event = { type: "ryugi-" + kind, artifact, command, ...fields };
    const message = { kind, text: wakeMessage(event, 500) };
    // T3 has no length cap, so a submit gets its brief inline once rendered outside the store lock.
    if (kind !== "comments" && !fields.withdrawn) message.render = { ...event, argv };
    messages.push(message);
  }
  const rounds = artifact.startsWith("artboard/")
    ? (read(path.join(state, "rounds.json"))?.rounds ?? [])
    : [];
  const drafts = rounds.filter((r) => r.state === "open" || baseline.roundStates[r.id] === "open");
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
  let changed = false,
    shown = 0,
    omitted = 0;
  const brief = [];
  for (const thread of threads) {
    if (thread.status === "resolved") continue;
    const a = thread.anchor || {};
    const draft =
      a.ask !== undefined ||
      a.submit !== undefined ||
      drafts.some(
        (r) =>
          (r.groups || []).includes(a.group) ||
          (r.boards || []).includes(a.board) ||
          a.nodes?.some((n) => r.boards?.includes(n.board)),
      );
    const human = thread.messages.filter((m) => m.author === "human");
    const messages = [];
    humanTokens(thread).forEach(({ token }, i) => {
      const m = human[i];
      const key = JSON.stringify([thread.id, m ? "message" : "status", m?.id]);
      if (baseline.seenComments[key] === token) return;
      baseline.seenComments[key] = token;
      if (draft || initial) return;
      changed = true;
      if (!m) return;
      if (shown++ >= 20) {
        omitted++;
        return;
      }
      const chars = Array.from(new Intl.Segmenter().segment(m.text || ""), (v) => v.segment);
      messages.push({
        id: m.id,
        at: m.at,
        name: m.name || "human",
        text: chars.length > 400 ? chars.slice(0, 400).join("") + "…" : m.text || "",
      });
    });
    if (messages.length)
      brief.push({
        thread: thread.id,
        status: thread.status,
        block: a.blockId || a.board,
        messages,
      });
  }
  if (changed) {
    const unread = unreadCount(project, artifact, host);
    if (unread) emit("comments", { threads: brief, unread, omitted });
  }
  return messages;
}
module.exports = { emptyBaseline, scan, render, listArgv };
