# Ryugi × T3 Code

T3 线程里的 agent 运行 `ryugi start --artifact artboard/layout` 后，接着运行 `ryugi-t3-watch subscribe`，之后的提交、撤回和人类评论会送回这个线程。线程 ID 取自 `--thread` 或 T3 注入的 `T3CODE_THREAD_ID`（Claude、Codex、Pi、Antigravity 都有）；都没有时报错并提示用 `orchestrator_capabilities` 的 `parentThreadId` 重试。不需要任何宿主 hook 或扩展。订阅期间，项目里所有 Ryugi 原生订阅都会去掉这个产物，反馈只由 T3 投递一次；线程结束一轮时立即触发云端发布。换宿主时跟随线程当前的评论游标。同一产物在另一线程重新订阅即转移归属。

给 agent 的说明在 [t3-instructions.md](t3-instructions.md)，已放进 Codex、Pi、Antigravity 的全局说明和 `~/.claude/CLAUDE.md`。

```sh
ryugi-t3-watch subscribe --project "$PWD" --artifact artboard/layout [--thread THREAD]
ryugi-t3-watch selection-context --cwd "$PWD" [--host Codex]
ryugi-t3-watch list
ryugi-t3-watch status --project "$PWD" --artifact artboard/layout
ryugi-t3-watch unsubscribe --project "$PWD" --artifact artboard/layout
ryugi-t3-watch prune
ryugi-t3-watch doctor
```

`doctor` 检查 Ryugi 插件是否仍提供桥接借用的接口，并用一个临时项目对照 Ryugi 原生 watcher 和桥接的提醒文本与命令参数，每次升级 Ryugi 后可以手动运行。`subscribe` 和 worker 启动时也会自动运行：自检不通过时 `subscribe` 报错且不订阅；worker 暂停转发，给每个已订阅的线程发一条说明，反馈留在 Ryugi 文件里不丢。插件文件一变，worker 就退出，由 launchd 拉起后重新自检，修好或回退 Ryugi 后自动恢复。

提交和回答的提醒会内联 Ryugi 的 `comment list --format brief` 结果（Ryugi 1.86 起原生宿主也这么做），agent 不必再跑一次命令。这条命令最多 15 秒，在存储锁外执行，执行完之前同一订阅的后续反馈排在它后面。Ryugi 服务器没在运行时读取失败，提醒退回附带 Run 命令的写法。评论提醒保持原样。

首次订阅记录现状，续订保留基线并延期（默认七天，`--ttl` 单位秒）。macOS 的单个按需 launchd 作业按状态目录隔离，空表后退出。状态保存在 `${XDG_STATE_HOME:-~/.local/state}/ryugi-t3-watch`。投递回执不明时核对最近 50 条消息，保留未确认记录供 `status` 查看。

运行需要 Node.js 22+、本机 T3 CLI 和位于 `~/.gemini/config/plugins/ryugi` 的 Ryugi 插件（`RYUGI_T3_WATCH_PLUGIN` 可指向别的副本），没有 npm 依赖。运行 `npm test` 验证桥接，真实 launchd 测试使用临时状态目录。`selection-context` 不带 `--host` 时只输出选区，不输出评论提醒。
