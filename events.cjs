const { unreadCount, wakeMessage } = require("./upstream.cjs");

const quote = (s) => "'" + s.replaceAll("'", "'\"'\"'") + "'";
// The worker runs outside any agent, so Ryugi's CLI is told whose unread comments to list
// (AI_AGENT wins over its environment sniffing).
const agents = { "Claude Code": "claude", Codex: "codex", Antigravity: "antigravity", pi: "pi", Grok: "grok" };
// Ryugi names its own launcher; the agent is shown the one it ran start with (Codex binds commands to --ryugi-session).
function rebound(text, r) {
  if (!r) return text;
  const from = r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`(["']?)${from}\\1`, "g"), () => r.to);
}
// Runs Ryugi's list command for up to 15 s; a failed read keeps the Run command.
// A submit also brings the comments still unread when it renders, in Ryugi's own comments format.
function render(event) {
  const f = event.followUp;
  const before = process.env.AI_AGENT;
  if (agents[f?.host]) process.env.AI_AGENT = agents[f.host];
  try {
    const text = wakeMessage(event, Infinity);
    const unread = f ? unreadCount(f.project, event.artifact, f.host) : 0;
    if (!unread) return rebound(text, event.rebind);
    const comments = { type: "ryugi-comments", artifact: event.artifact, unread, command: f.command, argv: f.argv };
    return rebound(text + "\n\n" + wakeMessage(comments, Infinity), event.rebind);
  } finally {
    if (before === undefined) delete process.env.AI_AGENT;
    else process.env.AI_AGENT = before;
  }
}
// Only a click in the viewer (submit or withdraw) is sent; comments ride along with the next submit.
// A submit's brief is inlined later, outside the store lock (render).
function message(event, record, host) {
  const kind = { "ryugi-choices": "choices", "ryugi-answers": "answers" }[event.type];
  if (!kind) return null;
  // Without Ryugi's list argv there is no brief to inline; the Run line still works.
  const launcher = event.argv?.[0];
  const rebind = launcher && record.launcher && {
    from: launcher,
    to: quote(record.launcher) + (record.proof ? " --ryugi-session " + record.proof : ""),
  };
  const text = rebound(wakeMessage(event, 500), rebind);
  if (event.withdrawn || !launcher) return { kind, text };
  const { project } = record;
  const argv = [launcher, "comment", "list", "--section", "threads", "--detail", "--format", "brief",
    "--project-dir", project, "--artifact", event.artifact];
  const command = `node ${quote(launcher)} ${argv.slice(1, -3).join(" ")} ${quote(project)} --artifact ${event.artifact}`;
  return { kind, text, render: { ...event, followUp: { project, host, argv, command }, ...(rebind && { rebind }) } };
}
module.exports = { message, render };
