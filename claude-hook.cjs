#!/usr/bin/env node
// Claude Code PostToolUse hook for Bash, set only for T3 threads through the Claude launch argument
// `--settings <this dir>/claude-settings.json`. Claude strips NODE_OPTIONS from its Bash commands, so
// preload.cjs never runs there; this does the same from the command line and tells the agent as context.
const os = require("node:os");
const path = require("node:path");
const autosub = require("./autosub.cjs");
const launcher = /(?:^|[\\/])ryugi(?:-artifacts)?\.cjs$/;

// Shell words per simple command. Only $PWD expands; any other expansion stays marked with "$".
function commands(line, cwd) {
  const out = [[]];
  let word = null,
    quote = null;
  const push = () => {
    if (word !== null) out[out.length - 1].push(word);
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
    if (c === "'" || c === '"') {
      quote = c;
      word = word ?? "";
    } else if (/\s/.test(c) && c !== "\n") push();
    else if (/[;&|()\n]/.test(c)) {
      push();
      if (out[out.length - 1].length) out.push([]);
    } else word = (word ?? "") + c;
  }
  push();
  return out.filter((words) => words.length);
}

function context(input) {
  if (!process.env.T3CODE_THREAD_ID || input.tool_name !== "Bash") return null;
  let cwd = input.cwd || process.cwd();
  const notes = [];
  for (const words of commands(String(input.tool_input?.command || ""), cwd)) {
    if (words[0] === "cd") cwd = path.resolve(cwd, (words[1] || os.homedir()).replace(/^~(?=$|\/)/, os.homedir()));
    const at = words.findIndex((w) => launcher.test(w));
    if (at < 0) continue;
    const args = words.slice(at + 1);
    const goal = autosub.target(args, cwd);
    if (!goal) continue;
    if (args.some((w) => w.includes("$")))
      notes.push(
        `ryugi-t3-watch: 项目目录含变量，未能订阅 ${goal.artifact}。运行 ryugi-t3-watch subscribe --project <项目目录> --artifact ${goal.artifact} 补订。`,
      );
    else notes.push(autosub.subscribe(goal, cwd));
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
