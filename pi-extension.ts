import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

export default function (pi: ExtensionAPI) {
  if (!process.env.T3CODE_THREAD_ID) return;
  process.env.AI_AGENT ||= "pi";
  const thread = process.env.T3CODE_THREAD_ID;
  const bin = process.env.RYUGI_T3_WATCH_BIN || join(homedir(), ".local/bin/ryugi-t3-watch");
  const exec = promisify(execFile);
  async function bridge(op: string, cwd: string, ...args: string[]) {
    try {
      const { stdout } = await exec(
        bin,
        [op, "--cwd", cwd, "--host", "pi", "--thread", thread, ...args],
        { timeout: op === "selection-context" ? 1500 : 8000 },
      );
      return stdout.trimEnd();
    } catch {
      return "";
    }
  }
  pi.on("session_start", async (_, ctx) => {
    await bridge("session-start", ctx.cwd);
  });
  pi.on("before_agent_start", async (event, ctx) => {
    if (event.messageType !== "user") return;
    const content = await bridge(
      "selection-context",
      ctx.cwd,
      "--session-id",
      ctx.sessionManager.getSessionId(),
      "--prompt=" + event.prompt,
    );
    if (content) return { message: { customType: "ryugi-selection", content, display: false } };
  });
  pi.on("tool_result", async (event, ctx) => {
    if (event.isError || (event.toolName !== "bash" && event.toolName !== "exec_command")) return;
    const input = (event.input ?? {}) as {
      command?: unknown;
      cmd?: unknown;
      cwd?: unknown;
      workdir?: unknown;
    };
    const command =
      typeof input.command === "string"
        ? input.command
        : typeof input.cmd === "string"
          ? input.cmd
          : "";
    if (!command.includes("ryugi") || !command.includes("--artifact")) return;
    const subCwd =
      typeof input.workdir === "string"
        ? input.workdir
        : typeof input.cwd === "string"
          ? input.cwd
          : ".";
    await bridge("observe-command", resolve(ctx.cwd, subCwd), "--command=" + command);
  });
  pi.on("agent_end", async (_, ctx) => {
    await bridge("turn-end", ctx.cwd);
  });
}
