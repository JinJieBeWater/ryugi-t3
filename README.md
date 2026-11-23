# Ryugi × T3 Code

把 Ryugi 产物上的反馈送回 T3 Code 线程。人在 Ryugi 查看器里留评论、提交一轮选项或回答问题后，运行过 `ryugi start` 的那个 T3 线程会收到一条唤醒消息。

需要 macOS、Node.js 22+、Ryugi 1.102.8+ 和 T3 Code。

## 安装

1. 在 `~/.config/ryugi/config.json` 里加一个自定义宿主：

   ```json
   {
     "hosts": {
       "t3": {
         "env": "T3CODE_THREAD_ID",
         "agent": "T3 Code",
         "command": ["/Users/<you>/my/tools/ryugi-t3/ryugi-t3"],
         "timeoutMs": 45000
       }
     }
   }
   ```

2. 运行 `./launchd.sh`，装上常驻进程。卸载用 `./launchd.sh uninstall`。

配置一分钟内生效，T3 和 provider 都不用重启。T3 给 Claude、Codex、Pi 和 Antigravity 线程都设了 `T3CODE_THREAD_ID`，四种 provider 走同一条路。T3 的终端里没有这个变量，在那里跑 `ryugi start` 仍按原生宿主处理。

`timeoutMs` 要大于 30 秒。`deliver.cjs` 最多调用三次 `t3`，每次最多等 10 秒。Ryugi 默认 15 秒就杀掉命令再投一次，已经送达的反馈会重复出现。

## 投递

Ryugi 每有一条反馈就运行一次 [deliver.cjs](deliver.cjs)，stdin 是事件 JSON。

- 用 `t3 thread send` 把 `wakeMessage` 发到 `session` 指定的线程。线程忙时，T3 把消息排到下一轮。T3 返回 `started`、`queued`、`steered` 或 `restarted` 时，退出 0。
- 线程已归档或已删除时，退出 10，Ryugi 随即退订。
- 发送失败时，先看线程最新一条用户消息。它就是这条反馈，说明发送其实成功了，按送达处理；否则退出 1，由 Ryugi 退避重试。

T3 CLI 的路径取 `T3CODE_CLI_PATH`，数据目录取 `T3CODE_HOME`，默认是 `~/.t3`。

## 常驻进程

`./launchd.sh` 装的是 launchd 任务 `dev.ryugi-t3.serve`，它运行 [serve.cjs](serve.cjs)。任务开机启动，退出后自动拉起，日志在 `~/Library/Logs/ryugi-t3.log`。

Ryugi 自己的做法是让 `ryugi start` 在 agent 的 shell 里为每个会话拉起一个 watcher，由它持有 hub 连接。在 T3 里这个 watcher 活不长。Claude CLI 退出时，T3 会 `SIGKILL` 它留下的所有进程，watcher 也在其中。重启电脑后 watcher 也没了。没有连接，反馈就一直留在 hub 里。

serve.cjs 读 hub 的订阅表 `~/.ryugi/server/agent-subscriptions.json`，为每个自定义宿主的订阅开一条 hub 连接，收到反馈就运行上面的投递命令。hub 每个会话只保留最新的连接。`ryugi start` 拉起的 watcher 连进来会顶掉 serve.cjs，一秒后 serve.cjs 再顶回去，watcher 被顶掉后自行退出。hub 没在运行时，serve.cjs 会启动它。

serve.cjs 用的是 Ryugi 的内部实现，包括订阅表的格式，以及插件里的 `hub-channel.cjs`、`delivery-queue.cjs`、`cmd-comment-watch.cjs` 和 `custom-hosts.cjs`。这些模块从 `ryugi update` 维护的安装目录加载。插件版本变了，serve.cjs 会退出，launchd 用新模块重新启动它。哪天 Ryugi 在 agent 进程树之外运行自定义宿主命令，这个常驻进程就可以卸掉。

## 升级 Ryugi 之后

`ryugi update` 只刷新 Claude Code 插件的 marketplace，不升级已经装好的插件。用 `claude plugin list` 核对版本；旧了就运行 `claude plugin update ryugi@ryugi-dev`。不更新的话，T3 里的 Claude 线程还按旧插件订阅，反馈不会走这里。

## 开发

运行 `npm test`。serve 的测试会加载本机安装的 Ryugi 插件。
