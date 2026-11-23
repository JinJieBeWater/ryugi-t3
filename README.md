# Ryugi × T3 Code

Ryugi 1.102.8 起支持自定义宿主：`start` 认出宿主的会话环境变量后，产物反馈不再交给 provider 自己的 watcher，而是交给配置的命令投递。本仓库就是 T3 Code 的那个命令，把反馈送回运行 `start` 的 T3 线程。

## 配置

在 `~/.config/ryugi/config.json` 里加：

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

`timeoutMs` 要大于 30 秒。deliver.cjs 最多调用三次 `t3`，每次最多等 10 秒；Ryugi 默认 15 秒就杀掉命令并重投，一条其实已经送达的反馈会再发一遍。

改完后一分钟内生效，不用重启 T3 或 provider。Claude、Codex、Pi、Antigravity 线程的 shell 里都有 `T3CODE_THREAD_ID`，所以在 T3 里四种 provider 的行为相同。

## 常驻连接

运行 `./launchd.sh` 安装，`./launchd.sh uninstall` 卸载。安装后 launchd 开机即启动 [serve.cjs](serve.cjs)，退出后自动拉起，日志在 `~/Library/Logs/ryugi-t3.log`。

为什么需要它：Ryugi 在 agent 的 shell 里给每个会话拉起一个 watcher。T3 在 Claude CLI 退出时会 `SIGKILL` 它留下的所有进程，watcher 也在其中；重启电脑后 watcher 也都不在了。没有 watcher，反馈就一直留在 hub 里，不会送到线程。

serve.cjs 读 hub 的订阅表 `~/.ryugi/server/agent-subscriptions.json`，为每个自定义宿主的订阅开一条 hub 连接，收到反馈后交给下面的投递命令。同一会话 hub 只保留最新的连接：`start` 拉起的 Ryugi watcher 连进来会顶掉 serve.cjs，serve.cjs 一秒后再连回去，Ryugi 的 watcher 被顶掉后自行退出。hub 没在跑时，serve.cjs 会拉起它。

serve.cjs 依赖上游的两处内部实现：订阅表的格式，以及插件里的 `hub-channel.cjs`、`delivery-queue.cjs`、`cmd-comment-watch.cjs`、`custom-hosts.cjs`。模块从 `ryugi update` 维护的安装目录里加载；插件版本一变，serve.cjs 会退出，由 launchd 用新模块重新拉起。上游如果改由 hub 直接运行宿主命令，这一节连同 serve.cjs 和 launchd.sh 都可以删掉。

## 投递

Ryugi 每有一条反馈就运行一次 [deliver.cjs](deliver.cjs)，stdin 是事件 JSON。

- 用 `t3 thread send` 把 `wakeMessage` 发到 `session` 指向的线程。线程忙时 T3 把消息排到下一轮。收到 T3 的回执（`started`、`queued`、`steered` 或 `restarted`）就退出 0。
- 线程已归档或 T3 里已经没有这个线程时，退出 10，随即退订。
- 发送失败时，如果线程最新一条用户消息就是这条反馈，说明发送其实已经成功，按送达处理，免得重发一遍；否则退出 1，退避重试。

`ryugi update` 不会升级 Claude Code 里已经装好的插件，只刷新它的 marketplace。升级后用 `claude plugin list` 核对版本，旧版本需要再跑一次 `claude plugin update ryugi@ryugi-dev`，否则 T3 里的 Claude 线程还按旧插件注册，反馈不会走这里。

T3 CLI 取 `T3CODE_CLI_PATH`，数据目录取 `T3CODE_HOME`，默认是 `~/.t3`。需要 Node.js 22+。运行 `npm test` 验证。
