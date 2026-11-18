const path = require("node:path");
const { projectRoot } = require("./upstream.cjs");
const artifactPattern = /^(?:document|artboard|whiteboard|slides)\/[a-z0-9][a-z0-9-]*$/;

function extractStartArtifacts(source, cwd) {
  if (!source?.includes("ryugi") || !source.includes("--artifact")) return [];
  const { syntax } = require("mvdan-sh");
  let file;
  try {
    file = syntax.NewParser().Parse(source, "tool command");
  } catch {
    return [];
  }
  const bytes = Buffer.from(source);
  function literal(parts, quoted = false, currentCwd = cwd) {
    let text = "";
    for (let idx = 0; idx < parts.length; idx++) {
      const part = parts[idx];
      switch (syntax.NodeType(part)) {
        case "SglQuoted":
          text += part.Value;
          break;
        case "Lit": {
          let val = part.Value.replace(quoted ? /\\(["\\$\x60\n])/g : /\\(.)/gs, "$1");
          if (!quoted && idx === 0 && (val === "~" || val.startsWith("~/"))) {
            val = require("node:os").homedir() + val.slice(1);
          }
          text += val;
          break;
        }
        case "ParamExp": {
          const spelling = bytes.subarray(part.Pos().Offset(), part.End().Offset()).toString();
          if (["$HOME", "${HOME}"].includes(spelling)) text += require("node:os").homedir();
          else if (currentCwd && ["$PWD", "${PWD}"].includes(spelling)) text += currentCwd;
          else return null;
          break;
        }
        case "DblQuoted": {
          const inner = literal(part.Parts, true, currentCwd);
          if (inner === null) return null;
          text += inner;
          break;
        }
        default:
          return null; // Never evaluate shell expansions.
      }
    }
    return text;
  }
  const matches = [];
  function visit(stmt, state) {
    const cmd = stmt?.Cmd;
    if (!cmd) return;
    const kind = syntax.NodeType(cmd);
    if (kind === "BinaryCmd") {
      if (cmd.Op === 10) {
        // &&
        visit(cmd.X, state);
        visit(cmd.Y, state);
      } else if (cmd.Op === 12 || cmd.Op === 13) {
        // | or |& (each pipeline stage runs in its own subshell cwd)
        visit(cmd.X, { cwd: state.cwd });
        visit(cmd.Y, { cwd: state.cwd });
      }
      return;
    }
    if (kind === "Subshell") {
      const inner = { cwd: state.cwd };
      for (const s of cmd.Stmts || []) visit(s, inner);
      return;
    }
    if (kind === "Block") {
      for (const s of cmd.Stmts || []) visit(s, state);
      return;
    }
    if (kind !== "CallExpr") return;
    const args = cmd.Args.map((word) => literal(word.Parts, false, state.cwd));
    const exe = path.basename(args.shift() || "");
    if (exe === "cd") {
      state.cwd = state.cwd && args[0] ? path.resolve(state.cwd, args[0]) : null;
      return;
    }
    if (exe === "node" && path.basename(args[0] || "") === "ryugi.cjs") args.shift();
    else if (!["ryugi", "ryugi.cjs"].includes(exe)) return;
    if (args[0] === "--ryugi-session" && /^[\da-f-]{36}:[\da-f-]{36}$/i.test(args[1]))
      args.splice(0, 2);
    if (args.shift() !== "start" || args.includes("--help") || args.includes("-h")) return;
    function option(name, fallback) {
      const i = args.findIndex((a) => a === name || a?.startsWith(name + "="));
      return i < 0 ? fallback : args[i] === name ? args[i + 1] : args[i].slice(name.length + 1);
    }
    const artifact = option("--artifact");
    const dir = option("--project-dir", ".");
    const targetDir =
      dir && (path.isAbsolute(dir) ? dir : state.cwd ? path.resolve(state.cwd, dir) : null);
    if (!artifactPattern.test(artifact) || !targetDir) return;
    try {
      matches.push({ project: projectRoot(targetDir), artifact });
    } catch {}
  }
  const topState = { cwd };
  for (const stmt of file.Stmts) visit(stmt, topState);
  return matches;
}
module.exports = { extractStartArtifacts, artifactPattern };
