#!/usr/bin/env node
// Claude Code PostToolUse hook for Bash, set only for T3 threads through the Claude launch argument
// `--settings <this dir>/claude-settings.json`. Claude strips NODE_OPTIONS from its Bash commands, so
// preload.cjs never runs there; this does the same from the command line and tells the agent as context.
const os = require("node:os");
const path = require("node:path");
const autosub = require("./autosub.cjs");
const { projectRoot } = require("./upstream.cjs");
const launcher = /(?:^|[\\/])ryugi(?:-artifacts)?\.cjs$/;

// Shell words per simple command. A leading unquoted ~ and $PWD expand; any other expansion stays
// marked with "$". Redirections (2>&1, >out) are dropped with their target, heredoc bodies and
// here-strings with theirs.
// Index just past the delimiter line of each pending heredoc, starting at a line start.
function skipBodies(line, i, docs) {
  for (const { end, strip } of docs) {
    while (i < line.length) {
      const nl = line.indexOf("\n", i);
      const row = line.slice(i, nl < 0 ? line.length : nl);
      i = nl < 0 ? line.length : nl + 1;
      if ((strip ? row.replace(/^\t+/, "") : row) === end) break;
    }
  }
  return i;
}

function commands(line, cwd, home = os.homedir()) {
  const out = [[]];
  let word = null,
    quote = null,
    redirect = false;
  const heredocs = [];
  const push = () => {
    if (word !== null && !redirect) out[out.length - 1].push(word);
    if (word !== null) redirect = false;
    word = null;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
      continue;
    }
    if (c === "$") {
      const m = /^\$(?:PWD\b|\{PWD\})/.exec(line.slice(i));
      if (m) {
        word = (word ?? "") + cwd;
        i += m[0].length - 1;
        continue;
      }
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else word += c;
      continue;
    }
    if (c === "~" && word === null && /^(?:$|[\/\s;&|()])/.test(line[i + 1] ?? "")) {
      word = home;
      continue;
    }
    if (c === "<" && line[i + 1] === "<" && line[i + 2] === "<") {
      // A here-string: its word is data.
      push();
      i += 2;
      redirect = true;
      continue;
    }
    if (c === "<" && line[i + 1] === "<") {
      // A heredoc: its body, up to the delimiter line, is data.
      push();
      i += 2;
      const strip = line[i] === "-";
      if (strip) i++;
      const m = /^[ \t]*(['"]?)([^\s'";&|<>()]+)\1/.exec(line.slice(i));
      if (m) {
        i += m[0].length;
        heredocs.push({ end: m[2], strip });
      }
      i--;
      continue;
    }
    if (c === ">" || c === "<") {
      if (/^\d+$/.test(word ?? "")) word = null;
      push();
      while (/[>&|]/.test(line[i + 1] ?? "")) i++;
      redirect = true;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word = word ?? "";
    } else if (/\s/.test(c) && c !== "\n") push();
    else if (/[;&|()\n]/.test(c)) {
      push();
      if (out[out.length - 1].length) out.push([]);
      if (c === "\n" && heredocs.length) i = skipBodies(line, i + 1, heredocs.splice(0)) - 1;
    } else word = (word ?? "") + c;
  }
  push();
  return out.filter((words) => words.length);
}

function context(input) {
  if (!process.env.T3CODE_THREAD_ID || input.tool_name !== "Bash") return null;
  let cwd = input.cwd || process.cwd();
  // Ryugi's own prompt hook already shows Claude the selection of its session's project.
  let session = null;
  try {
    session = projectRoot(process.env.CLAUDE_PROJECT_DIR || cwd);
  } catch {}
  const notes = [];
  for (const words of commands(String(input.tool_input?.command || ""), cwd)) {
    if (words[0] === "cd") cwd = path.resolve(cwd, words[1] || os.homedir());
    const at = words.findIndex((w) => launcher.test(w));
    if (at < 0) continue;
    const args = words.slice(at + 1);
    const goal = autosub.target(args, cwd);
    if (!goal) continue;
    if (args.some((w) => w.includes("$")))
      notes.push(
        `ryugi-t3-watch: 项目目录含变量，未能订阅 ${goal.artifact}。运行 ryugi-t3-watch subscribe --project <项目目录> --artifact ${goal.artifact} 补订。`,
      );
    else {
      let own = null;
      try {
        own = projectRoot(goal.project);
      } catch {}
      const launcherPath = path.resolve(cwd, words[at]);
      notes.push(autosub.subscribe(goal, cwd, { launcher: launcherPath, selection: own === null || own !== session }));
    }
  }
  return notes.length ? notes.join("\n") : null;
}

if (require.main === module) {
  let raw = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    let text = null;
    try {
      text = context(JSON.parse(raw));
    } catch {}
    if (text)
      process.stdout.write(
        JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }),
      );
  });
}
module.exports = { commands, context };
