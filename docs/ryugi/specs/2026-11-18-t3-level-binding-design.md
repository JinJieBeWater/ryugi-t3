# Ryugi × T3：从线程层接入，去掉四套宿主适配（简化版）

状态：已批准方向（2026-11-18，简化版），待实现

## 为什么做

现在桥接器靠四套宿主适配器工作：Claude 的 `PostToolUse` hook、Codex 的四项 hook、Pi 扩展、Antigravity 的 ACP 包装器。它们各自要做四件事：

- 观察 shell 命令，把刚运行的 `ryugi start --artifact …` 绑定到当前 T3 线程。
- 发消息前读取查看器里的选区。
- 会话开始时预热 Ryugi 服务。
- 回合结束时触发云端刷新。

其中 Codex 的 hook 运行在多个线程共用的 app-server 环境里，拿不到线程 ID，只能用 `resolveCodex` 去猜。反馈投递本来就只有一套：worker 扫描后调用 `t3 thread send`。这一套保留。

**用户的决定**：

- 继续用官方 T3，不 fork。
- 打开时订阅，保留现有的线程投递，选区读取用公共命令。
- 采用本简化版：agent 照常运行 `ryugi start`，接着运行现有的 `subscribe`。不再新做 `open` 包装器、`selection` 命令和 worker 里的刷新逻辑。

## 已核对的事实

**线程 ID 在哪些 shell 里可用。** T3 会把 `T3CODE_THREAD_ID` 注入 agent 运行命令的 shell：Claude 用 `AGENT_THREAD_ENV`，Codex 用每线程的 `shell_environment_policy.set`（`CodexAdapterV2.ts:1530`），Pi 见 `provider-pi/src/server/adapter.ts:540`。2026-11-18 实测：

- Claude（本线程）和 Codex（子任务）的 shell 里都有这个变量。
- Antigravity 的 shell 里是 `<unset>`。它在 `agy` 进程里直接执行命令，拿不到 T3 只注入给 ACP 终端的环境变量。
- T3 MCP `orchestrator_capabilities` 返回的 `parentThreadId` 就是调用者自己的线程 ID（本线程实测）。

**现有命令已经够用。**

- `subscribe` 已经会读取环境变量里的线程（`watch.cjs:100`）。
- `selection-context` 在普通 shell 里也能运行（本线程实测：退出码 0，用时 0.05 秒）。

**云端刷新不是必需的。** Ryugi 服务的自动发布器会自己发布：编辑停 5 分钟后，最晚 15 分钟（`S$A=300s`，`F$A=900s`）。`/api/cloud/flush` 只是让它立刻发布。

**为什么必须删除原生订阅。** 在 T3 里运行 `ryugi start` 时，Ryugi 会按 `CODEX_THREAD_ID`、`CLAUDE_CODE_SESSION_ID` 或 `PI_SESSION_ID` 写入原生订阅：

- 现场有 `codex-comment-watch/4b2f….json` 和 `pi-comment-watch/01a1….json`。
- 三个原生 watcher 每次轮询都会重读订阅文件：`codex-comment-watch.cjs:217`、`comment-watch.cjs:395`、Pi 扩展的 `setInterval`。
- Pi 的 watcher 会用 `sendMessage(..., { triggerTurn: true })` 直接唤醒会话。

所以不删原生订阅，同一条反馈会收到两次。删掉之后，下一次轮询就不会再唤醒。

**Codex 原生订阅记在哪个会话下，不可靠。** Ryugi 的 Codex hook 在 T3 的 Codex 里会运行：现场的绑定 `01a1ee41…` 的 owner 是 T3 正在运行的 Codex app-server（pid 22951）。shell 里运行 `start` 时，`boundCodexSession` 按进程链找这个 app-server 下的绑定：

- **只有一个绑定时**，直接用它，不看 `CODEX_THREAD_ID`。所以当前线程还没绑定时，会记到别的线程名下。
- **有多个绑定时**，才按 `CODEX_THREAD_ID` 去匹配。

现场另一个绑定 `4b2f…` 也印证了这一点：它记录的继承 ID 是 `01a1eac5…`，跟会话本身不一致。所以清理原生订阅不能按会话 ID 找文件。

**selection-context 必须知道宿主。** 不传 `--host` 时，`reviewStateKey(artifact, undefined)` 找不到 agent 的已读状态，所有未解决的评论都会被当成未读，提醒全是误报。

**Claude 会读到全局说明。** T3 的 Claude 没有设置自定义 home，会加载 `user` 设置来源，所以 `~/.claude/CLAUDE.md` 有效。

## 目标

- 在任何 T3 provider 里，agent 运行 `start` 之后再运行一条 `subscribe`，之后的反馈就回到这个线程。不依赖宿主 hook。
- 用户说「改这里」时，agent 能用一条命令读到选区。
- 删除全部适配代码和宿主配置条目。

## 非目标与反目标

- 不改 T3，也不改 Ryugi 插件。
- 不改投递语义：忙时排队、核对回执、去重、TTL、线程归档后退订。
- 不再从命令文本、进程树或会话缓存推断线程。
- 同一条反馈不投递两次。

## 改动

### 代码（本仓库）

1. **T3 绑定的产物，原生订阅一律清掉，约 15 行。** 写在 `syncProjectHeartbeat` 里，它本来就在每次 `subscribe`、退订和 worker 的每一轮执行。
   - **清哪些**：遍历项目 `.ryugi/artifacts/.state/` 下所有 `*-comment-watch/` 目录里的 `*.json`，跳过我们自己的 `ryugi-t3-watch.json`。
   - **怎么清**：只要文件含有本项目里正在订阅的产物，就用 `atomic` 重写，去掉这些产物。
   - **为什么不按会话**：不看会话 ID，也不分宿主，所以 Codex 的会话 ID 是否对得上已经无所谓（见「已核对的事实」）。
   - **顺带关掉重复窗口**：agent 重新运行 `start` 后忘了 `subscribe`，Ryugi 会把原生订阅写回去，worker 下一轮（1–2.5 秒）就会再清掉。

   这项改动替代 `hooks.cjs` 里 `observeCommand` 只处理 Claude 的删除逻辑。**用户的决定**：只在 T3 里使用，所以 T3 订阅期间这些产物只由 T3 投递。
2. **`subscribe` 精简输出，1 行。** 改为只打印 `{ project, artifact, thread, deadline }`，不再打印整条记录。整条记录里有基线，评论多时达到 KB 级，会进入 agent 的上下文。**这是我的决定。**
3. **缺线程时自动找 Antigravity 线程，约 15 行。** `--thread` 和 `T3CODE_THREAD_ID` 都没有时：
   - 运行 `t3 thread list --project <project>`，取出 `providerInstanceId === "antigravity"`、`status === "running"`、并且未归档的线程。
   - 对每个候选运行 `show`：有 `worktreePath` 的，要求它的 `projectRoot` 等于本项目；没有 `worktreePath` 的照收。
   - 恰好剩一个时，就用它。调用者正在运行命令，所以它自己一定处于 running；只看 Antigravity，是因为只有它不注入线程 ID。
   - 剩零个或多个时，报错：「这个 shell 里没有 T3 线程 ID。在 T3 线程里（例如 Antigravity）时，先调用 T3 工具 orchestrator_capabilities，用返回的 parentThreadId 重试：ryugi-t3-watch subscribe --thread <parentThreadId> …」。

   **这是用户要求的优化**：让 Antigravity 在常见情况下不需要多走一步。
3b. **回合结束刷新，约 10 行。** worker 按 `[base, thread]` 记住上一次的 `status`。从 `running` 变为其他状态时，对这个线程订阅涉及的每个项目，在 `server-info` 存在的前提下调用 `postToServer(project, "/api/cloud/flush")`。worker 本来每 2 秒就会读一次线程状态，所以不增加 T3 调用。**这是用户要求的优化**：Codex、Pi、Antigravity 的云端发布不再推迟。
4. **`selection-context` 在不知道宿主时不出提醒，约 2 行。** 没传 `--host` 时，只输出选区，不输出评论提醒。评论本来就会由 worker 送回线程，少了提醒不丢信息。**这是我的决定。**
5. **删除。**
   - 文件：`hooks.cjs`、`parser.cjs`、`pi-extension.ts`。
   - `lifecycle.cjs` 里的 `session-start` 和 `turn-end`。
   - `cli.cjs` 的 `hook` 和 `observe-command` 分支，以及 `ryugi-t3-watch` 脚本里的 `hook:*` 门禁。
   - `store.cjs` 里的 `sessions`，读到旧数据时忽略。
   - `selection.cjs` 里按 `sessionId` 查找 owner 的分支。
   - `mvdan-sh` 依赖和 `bun.lock`。
   - `test/hooks.test.cjs`、`test/parser.test.cjs`、`test/pi.test.cjs`。
   - 更新 README。

### 全局说明（同一段文字）

> 在 T3 线程里打开 Ryugi 产物（`ryugi.cjs start --artifact …`）后，紧接着运行 `ryugi-t3-watch subscribe --artifact <type>/<id> --project <与 --project-dir 相同的目录>`，把提交和评论接回本线程；每次重新 start 都要再运行一次。用户说「这里」「这段」「选中的」却没给出位置时，先运行 `ryugi-t3-watch selection-context`；没有输出表示查看器里没有选区。

放在四处：

- Codex：`~/my/pi-stuff/config/shared/AGENTS.md`。
- Pi：`~/my/pi-stuff/config/pi/AGENTS.md`。
- Antigravity：`~/my/pi-stuff/config/antigravity/GEMINI.md`。
- Claude：新建 `~/.claude/CLAUDE.md`。

### 宿主配置清理

- `~/.codex/hooks.json` 里四项 `ryugi-t3-watch hook codex …`，以及 `~/.codex/config.toml` 里对应的 `hooks.state` 信任条目。
- `~/.claude/settings.json` 里 `ryugi-t3-watch hook claude post-tool-use` 这一项。
- `~/.pi/agent/extensions/ryugi-t3-watch.ts` 软链。
- `~/my/pi-stuff/config/antigravity/acp-wrapper.mjs` 里的 Ryugi 桥接部分（提交 3f70675、be27c2a），以及对应测试。

**顺序**：

1. 先上线代码改动 1–4 和全局说明，适配器暂时保留。
2. 在四个宿主上通过验收后，再删适配器和宿主配置。这一阶段，Codex 和 Pi 的 hook 可能在 agent 运行 `subscribe` 之前就完成了绑定，重复绑定没有副作用。
3. Antigravity 的包装器要等验收第 5 步通过才删。

旧订阅记录的格式不变，可以继续用。

## 已知取舍

- **绑定依赖 agent 照说明运行 `subscribe`。** 漏了不会报错，也不会投错线程，只是反馈回不到线程。
- **还剩一个很小的重复窗口。** 原生订阅被写入后、被清掉前（`subscribe` 前的几秒，或者重新 `start` 后的 1–2.5 秒），如果正好来了评论，原生唤醒和 T3 投递可能都会到。
- **T3 之外的原生唤醒会失效。** T3 订阅有效期间（默认七天），同一个产物在 T3 之外的 Ryugi 会话里收不到原生唤醒。用户只在 T3 里用，这一点可以接受。
- **会改写 Ryugi 的状态文件。** Ryugi 写这些文件时不加锁，可能把我们清掉的产物写回去；下一轮还会再清，最终一致。
- **只有订阅过的线程会触发刷新。** 绕过 `subscribe` 的线程，回合结束时不会刷新，要等自动发布，最多晚 5 到 15 分钟。
- **Antigravity 同时有多个线程在跑时，还要多走一步。** 自动查找会认成有歧义，agent 要按报错调用 `orchestrator_capabilities`，再带 `--thread` 重试。

## 交给实现者

- 测试组织方式沿用 `test/fixtures.cjs`。
- 清理原生订阅时，是否要处理文件读取失败、JSON 写到一半的情况：跳过即可，下一轮会重试。

## 验证

单元测试（`node --test`）：

- 订阅以后，项目里所有 `*-comment-watch/*.json` 都不再含有已订阅的产物；其中没订阅的产物保持不变；`ryugi-t3-watch.json` 不动；不需要任何会话环境变量。
- 原生文件被写回这个产物后，worker 跑一轮就会再清掉。
- 退订或订阅过期之后，不再清理。
- 没有线程时：恰好有一个属于本项目的 Antigravity running 线程，就自动选中它；没有或者有多个时，退出码非零，不写订阅，stderr 里带有 `orchestrator_capabilities` 的指引。
- worker 在线程状态从 `running` 变为 `idle` 时，对这个项目恰好调用一次 flush；状态不变时不调用。
- 输出只包含那四个字段。
- 不传 `--host` 时，`selection-context` 的输出里没有 `Unread comment evidence`；传了 `--host` 时，提醒和现在一样。
- 删除后，剩下的测试（`events`、`watch`、`lifecycle`）全部通过。

真实验收：每个宿主开一个 T3 线程，依次检查：

1. 让 agent 打开一个 artboard，确认它先运行 `start`，再运行 `subscribe`。
2. 运行 `ryugi-t3-watch status`，确认线程 ID 正确；确认项目里所有原生订阅文件都已经不含这个产物。
3. 在查看器里提交，线程**恰好收到一次**唤回；线程忙时再测一次，确认消息排队。
4. 选中一个节点后说「改这里」，agent 运行 `selection-context`，并改对了位置。
5. Antigravity：在只有一个 Antigravity 线程运行时，`subscribe` 不带 `--thread` 也能绑定到正确的线程。

## 本次对话用到的产物

无。决定来自对话、源码核对和三次实测：Claude 与 Codex 的 shell 环境变量、Antigravity 的 shell 环境变量、`parentThreadId`。以上都已写进正文。
