# Ryugi × T3 Code

T3 线程里的 agent 运行 `ryugi start --artifact artboard/layout` 后，接着运行 `ryugi-t3-watch subscribe`，之后的提交、撤回和人类评论会送回这个线程。线程 ID 取自 `--thread` 或 T3 注入的 `T3CODE_THREAD_ID`（Claude、Codex、Pi、Antigravity 都有）；都没有时报错并提示用 `orchestrator_capabilities` 的 `parentThreadId` 重试。不需要任何宿主 hook 或扩展。订阅期间，项目里所有 Ryugi 原生订阅都会去掉这个产物，反馈只由 T3 投递一次；线程结束一轮时立即触发云端发布。换宿主时跟随线程当前的评论游标。同一产物在另一线程重新订阅即转移归属。

agent 不需要任何说明，订阅在 agent 运行 Ryugi 的 `start` 时自动完成，规则在 [autosub.cjs](autosub.cjs)：只认 `ryugi.cjs`（或 `ryugi-artifacts.cjs`）的 `start`，按命令行里的 `--artifact` 和 `--project-dir` 订阅，再告诉 agent 选区要用 `selection-context` 读。`--help`、不回传反馈的产物类型和 T3 外的 shell 都跳过。订阅失败（自检不通过、Codex 沙盒写不了状态目录）时告诉 agent 原因和手动 `subscribe` 的命令，start 本身照常成功。两条入口都只配在 `~/.t3/userdata/settings.json` 的 T3 provider 里：

- Codex、Pi、Antigravity：`providerInstances.<id>.environment` 设 `NODE_OPTIONS=--require <本目录>/preload.cjs`，线程 shell 里每个 node 进程先加载 [preload.cjs](preload.cjs)。它在 start 成功退出后、或仍在运行满 3 秒时订阅，提示写在 stderr，Ryugi 的 stdout 不动。
- Claude：Claude Code 会从 Bash 命令的环境里去掉 `NODE_OPTIONS`，所以改用启动参数 `--settings <本目录>/claude-settings.json` 挂一个 Bash 的 PostToolUse hook，[claude-hook.cjs](claude-hook.cjs) 从命令行里拆出参数（跟随同一行里的 `cd`，只展开 `$PWD`），提示作为 hook 上下文交给 agent。项目目录写成别的变量时不猜，提示 agent 手动订阅。

改 environment 或启动参数后，已启动的 Codex app-server 和已有会话要重启才会读到。某个工具自己重设 `NODE_OPTIONS` 时，那次 start 不会自动订阅，可以手动运行 `subscribe`。

```sh
ryugi-t3-watch subscribe --project "$PWD" --artifact artboard/layout [--thread THREAD]
ryugi-t3-watch selection-context --cwd "$PWD" [--host Codex]
ryugi-t3-watch list
ryugi-t3-watch status --project "$PWD" --artifact artboard/layout
ryugi-t3-watch unsubscribe --project "$PWD" --artifact artboard/layout
ryugi-t3-watch prune
ryugi-t3-watch doctor
```

`doctor` 检查 Ryugi 插件是否仍提供桥接借用的接口，并用一个临时项目对照 Ryugi 原生 watcher 和桥接的提醒文本与命令参数，每次升级 Ryugi 后可以手动运行。`subscribe` 和 worker 启动时也会自动运行：自检不通过时 `subscribe` 报错且不订阅；worker 暂停转发，给每个已订阅的线程发一条说明（没拿到回执时先核对线程再重发，每 5 秒一次，直到送达），反馈留在 Ryugi 文件里不丢。插件文件一变，worker 就退出，由 launchd 拉起后重新自检，修好或回退 Ryugi 后自动恢复。

提交和回答的提醒会内联 Ryugi 的 `comment list --format brief` 结果（Ryugi 1.86 起原生宿主也这么做），agent 不必再跑一次命令。这条命令最多 15 秒，在存储锁外执行，执行完之前同一订阅的后续反馈排在它后面。Ryugi 服务器没在运行时读取失败，提醒退回附带 Run 命令的写法。评论提醒保持原样。

每次调用 T3 CLI 约耗 0.25 秒 CPU，所以线程空闲且没有待发消息时每 20 秒才查一次线程状态，线程在跑或有待发消息时每 2 秒一次；评论照常每轮扫描、立即投递，投递后转回 2 秒以便回合结束时触发发布。归档清理和用户自己发起的短回合的发布最多晚 20 秒。

首次订阅记录现状，续订保留基线并延期（默认七天，`--ttl` 单位秒）。macOS 的单个按需 launchd 作业按状态目录隔离，空表后退出。状态保存在 `${XDG_STATE_HOME:-~/.local/state}/ryugi-t3-watch`。投递回执不明时核对最近 50 条消息，保留未确认记录供 `status` 查看。

运行需要 Node.js 22+、本机 T3 CLI 和 `ryugi install` 安装的 Pi 集成，没有 npm 依赖。桥接默认使用 Ryugi 托管的 `~/.local/share/ryugi/install/plugins/pi/plugin`，不要求 T3 线程使用 Pi，也不固定版本。用 `ryugi update` 更新插件，不要加 `--cli-only`。非默认安装目录或开发检出可用 `RYUGI_T3_WATCH_PLUGIN` 指定插件目录。运行 `npm test` 验证桥接，真实 launchd 测试使用临时状态目录。`selection-context` 不带 `--host` 时只输出选区，不输出评论提醒。
