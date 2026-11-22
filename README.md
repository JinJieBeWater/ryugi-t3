# Ryugi × T3 Code

T3 线程里的 agent 运行 `ryugi start --artifact artboard/layout` 后，这个产物自动订阅到该线程（见下文，也可以手动运行 `ryugi-t3 subscribe`），之后用户在查看器里点提交或撤回，就会送回这个线程。评论不单独发送：提交那条消息末尾附上当时这个线程的宿主还没读的评论（Ryugi 原生 comments 格式），所以边改边评不会刷屏，也不会送去已经处理过的旧评论。whiteboard 和 slides 没有提交按钮，订阅后只剩云端发布。线程 ID 取自 `--thread` 或 T3 注入的 `T3CODE_THREAD_ID`（Claude、Codex、Pi、Antigravity 都有）；都没有时报错并提示用 `orchestrator_capabilities` 的 `parentThreadId` 重试。订阅期间，项目里所有 Ryugi 原生订阅都会去掉这个产物，反馈只由 T3 投递一次；线程结束一轮时立即触发云端发布。未读按线程当前的宿主计算。同一产物在另一线程重新订阅即转移归属。

agent 不需要任何说明，订阅在 agent 运行 Ryugi 的 `start` 时自动完成，规则在 [autosub.cjs](autosub.cjs)：只认 `ryugi.cjs`（或 `ryugi-artifacts.cjs`）的 `start`，按命令行里的 `--artifact` 和 `--project-dir` 订阅，再告诉 agent 选区要用 `selection-context` 读（Claude 线程里 Ryugi 自己的 hook 已经附上同一项目的选区，这句就省掉）。`--help`、不回传反馈的产物类型和 T3 外的 shell 都跳过。订阅失败（自检不通过、Codex 沙盒写不了状态目录）时告诉 agent 原因和手动 `subscribe` 的命令，start 本身照常成功。两条入口都只配在 `~/.t3/userdata/settings.json` 的 T3 provider 里：

- Codex、Pi、Antigravity：`providerInstances.<id>.environment` 设 `NODE_OPTIONS=--require ~/.local/share/ryugi-t3/preload.cjs`（写成绝对路径）。
- Claude：Claude Code 会从 Bash 命令继承的环境里去掉 `NODE_OPTIONS`，所以改用启动参数 `--settings <本目录>/claude-settings.json` 挂一个 SessionStart hook，[claude-hook.cjs](claude-hook.cjs) 把同一句 `NODE_OPTIONS` 写进 `CLAUDE_ENV_FILE`（Claude 在每条 Bash 命令前 source 它），另外记下会话所在项目，那个项目的选区提示就省掉。

`NODE_OPTIONS` 指向的不是本目录，而是 `ryugi-t3 install` 写到 `~/.local/share/ryugi-t3/` 的一个壳文件（见 [entry.cjs](entry.cjs)）。它只尝试加载本目录的 preload，本目录被移走、删掉或改出语法错误时，node 照常运行，只是 start 不再自动订阅，并在那次 start 的 stderr 里说明。壳文件本身被删掉时 node 会启动失败，所以 `doctor` 会检查它和 T3 的几处配置。不能让壳把自己从 `NODE_OPTIONS` 里去掉：Codex、Pi、Antigravity 的宿主本身是 node 进程，去掉后它们的 shell 就拿不到了。

两条入口之后都一样：线程 shell 里每个 node 进程先加载 [preload.cjs](preload.cjs)，它从 Ryugi 进程自己的 argv 读参数，在 start 成功退出后、或仍在运行满 3 秒时订阅，提示写在 stderr，Ryugi 的 stdout 不动。

改 environment 或启动参数后，已启动的 Codex app-server 和已有会话要重启才会读到。某个工具自己重设 `NODE_OPTIONS` 时，那次 start 不会自动订阅，可以手动运行 `subscribe`。

```sh
ryugi-t3 install
ryugi-t3 subscribe --project "$PWD" --artifact artboard/layout [--thread THREAD]
ryugi-t3 selection-context --cwd "$PWD"
ryugi-t3 list
ryugi-t3 status --project "$PWD" --artifact artboard/layout
ryugi-t3 unsubscribe --project "$PWD" --artifact artboard/layout
ryugi-t3 doctor
```

桥接不复制 Ryugi 的逻辑：提交和撤回由 Ryugi 导出的 `createCommentWatch` 检测，提醒文本由它的 `wakeMessage` 生成，选区由它的 prompt hook 输出。借用的导出函数和 hook 全部列在 [upstream.cjs](upstream.cjs) 的 `contract` 里，Ryugi 代码也只从那里加载。

`doctor` 逐项检查这份清单（选区 hook 还要能实际运行），再用临时项目确认 Ryugi 的 watcher 仍然把提交和回答报成桥接转发的事件；只用来去掉选区里未读提醒的两个 hook 函数缺失时只警告。每次升级 Ryugi 后可以手动运行。`subscribe` 和 worker 启动时也会自动运行：自检不通过时 `subscribe` 报错且不订阅；worker 暂停转发，给每个已订阅的线程发一条说明（没拿到回执时先核对线程再重发，每 5 秒一次，直到送达）。清单里的文件一变，worker 就退出，由 launchd 拉起后重新自检，修好或回退 Ryugi 后自动恢复。

提交和回答的提醒会内联 Ryugi 的 `comment list --format brief` 结果（Ryugi 1.86 起原生宿主也这么做），agent 不必再跑一次命令。这条命令最多 15 秒，在存储锁外执行，执行完之前同一订阅的后续反馈排在它后面。Ryugi 服务器没在运行时读取失败，提醒退回附带 Run 命令的写法。提醒里的 Run 命令用 agent 运行 start 时的那个启动器，Codex 带上它的 `--ryugi-session`，否则 Codex 会拒绝运行。

每次调用 T3 CLI 约耗 0.25 秒 CPU，所以线程空闲且没有待发消息时每 20 秒才查一次线程状态，线程在跑或有待发消息时每 2 秒一次；提交照常每轮扫描、立即投递，投递后转回 2 秒以便回合结束时触发发布。归档清理和用户自己发起的短回合的发布最多晚 20 秒。

检测状态只在 worker 内存里：worker 第一次看到一个订阅时，产物当时的状态就是基线。所以 worker 停着的时候（Ryugi 升级后重启的几秒、自检暂停期间、重启机器后到下一次订阅之前）发生的提交不会补发，Ryugi 自己的原生 watcher 也一样。续订只延期（默认七天，`--ttl` 单位秒）。macOS 的单个按需 launchd 作业按状态目录隔离，空表后退出。状态保存在 `${XDG_STATE_HOME:-~/.local/state}/ryugi-t3`。投递回执不明时核对最近 50 条消息，保留未确认记录供 `status` 查看。

运行需要 Node.js 22+、本机 T3 CLI 和 `ryugi install` 安装的 Pi 集成，没有 npm 依赖。桥接默认使用 Ryugi 托管的 `~/.local/share/ryugi/install/plugins/pi/plugin`，不要求 T3 线程使用 Pi，也不固定版本。用 `ryugi update` 更新插件，不要加 `--cli-only`。非默认安装目录或开发检出可用 `RYUGI_T3_PLUGIN` 指定插件目录。运行 `npm test` 验证桥接，真实 launchd 测试使用临时状态目录。`selection-context` 输出 Ryugi prompt hook 的选区部分，去掉它附带的未读评论提醒（未读评论随提交送达）。
