const path = require("node:path");
const fs = require("node:fs");
const { extractStartArtifacts, artifactPattern } = require("./parser.cjs");
const { atomic, load, locked } = require("./store.cjs");
const { checkouts, projectRoot, sessionProjects, subscriptionFile, UUID } = require("./upstream.cjs");
const { transport, call, show, subscribe } = require("./watch.cjs");
const { lifecycle } = require("./lifecycle.cjs");

function resolveCodex(input) {
  const route = transport(),
    project = projectRoot(input.cwd);
  if (!input.session_id) return;
  const key = JSON.stringify([route.base, input.session_id]);
  const cached = load().sessions[key];
  if (cached) return cached;
  const candidates = new Set();
  // Nightly's thread list is project-scoped, including when --project is omitted.
  for (const target of [project, ...checkouts(project).filter((p) => p !== project), null]) {
    let rows;
    try {
      rows = call(route, "list", ...(target ? ["--project", target] : []));
    } catch {
      continue;
    }
    for (const row of rows) {
      if (row.archived || row.providerInstanceId !== "codex" || row.status !== "running") continue;
      const detail =
        row.worktreePath === undefined ? show({ ...route, thread: row.threadId }, 0).thread : row;
      if (detail.worktreePath) {
        if (projectRoot(detail.worktreePath) !== project) continue;
      } else if (target !== project) continue;
      candidates.add(row.threadId);
    }
    if (candidates.size) break;
  }
  const hint = process.env.T3CODE_THREAD_ID;
  if (hint && !candidates.has(hint)) {
    try {
      const detail = show({ ...route, thread: hint }, 0).thread;
      if (
        !detail.archived &&
        detail.status === "running" &&
        detail.providerInstanceId === "codex" &&
        detail.worktreePath &&
        projectRoot(detail.worktreePath) === project
      )
        candidates.add(hint);
    } catch {
      /* A stale inherited hint confers no ownership. */
    }
  }
  const ids = [...candidates];
  const matches =
    ids.length <= 1
      ? ids
      : ids.filter((thread) => {
          if (!input.prompt) return false;
          const last = show({ ...route, thread }, 1).messages.at(-1);
          return last?.role === "user" && last.text === input.prompt;
        });
  if (matches.length !== 1) return;
  return locked((db, save) => {
    db.sessions[key] ??= matches[0];
    save();
    return db.sessions[key];
  });
}

function observeCommand(opts, session) {
  const matches = extractStartArtifacts(opts.command, opts.cwd);
  for (const match of matches) {
    subscribe({ ...match, thread: opts.thread, host: opts.host });
    if (opts.host !== "Claude Code" || !session || !/^[a-zA-Z0-9_-]+$/.test(session)) continue;
    const file = subscriptionFile(match.project, "claude", session);
    locked(() => {
      if (!fs.existsSync(file)) return;
      const native = JSON.parse(fs.readFileSync(file));
      if (native.artifacts?.includes(match.artifact)) {
        native.artifacts = native.artifacts.filter((a) => a !== match.artifact);
        atomic(file, native);
      }
    });
  }
}

function syncCodexNative(cwd, session, thread) {
  if (!thread || !UUID.test(session || "")) return;
  const baseProject = projectRoot(cwd);
  const roots = new Set([
    baseProject,
    ...checkouts(baseProject),
    ...sessionProjects("codex", session),
  ]);
  for (const project of roots) {
    const file = subscriptionFile(project, "codex", session);
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      for (const artifact of data.artifacts || []) {
        if (artifactPattern.test(artifact)) {
          subscribe({ project, artifact, thread, host: "Codex" });
        }
      }
    } catch {}
  }
}

async function hook(host, event, input) {
  if (!input?.cwd) return;
  const claude = host === "claude";
  if (
    claude
      ? !process.env.T3CODE_THREAD_ID
      : host !== "codex" || !(process.env.T3CODE_DESKTOP_HOST_SCOPE || process.env.T3CODE_CLI_PATH)
  )
    return;
  const opts = {
    cwd: input.cwd,
    host: claude ? "Claude Code" : "Codex",
    "session-id": input.session_id,
    prompt: input.prompt,
  };
  if (event === "session-start") {
    if (!claude) await lifecycle("session-start", opts);
    return;
  }
  if (event === "stop") {
    if (!claude) {
      try {
        syncCodexNative(input.cwd, input.session_id, resolveCodex(input));
      } catch {}
      await lifecycle("turn-end", opts);
    }
    return;
  }
  if (event === "user-prompt-submit" && !claude) {
    // A stale checkout or an unavailable T3 session must not suppress the viewer selection.
    try {
      opts.thread = resolveCodex(input);
    } catch {
      opts.thread = null;
    }
    const context = lifecycle("selection-context", opts);
    if (context)
      console.log(
        JSON.stringify({
          hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context },
        }),
      );
    return;
  }
  if (event !== "post-tool-use") return;
  const tool = input.tool_input;
  const command = tool?.command || tool?.cmd;
  if (typeof command !== "string" || !command.includes("--artifact") || !command.includes("ryugi"))
    return;
  const thread = claude ? process.env.T3CODE_THREAD_ID : resolveCodex(input);
  if (thread)
    observeCommand(
      { ...opts, cwd: path.resolve(input.cwd, tool.workdir || "."), command, thread },
      input.session_id,
    );
}
module.exports = { hook, observeCommand };
