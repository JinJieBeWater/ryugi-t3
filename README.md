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
      "command": ["/Users/<you>/my/tools/ryugi-t3/ryugi-t3"]
    }
  }
}
```

改完后，下一次 `ryugi start` 起生效，不用重启 T3 或 provider。Claude、Codex、Pi、Antigravity 线程的 shell 里都有 `T3CODE_THREAD_ID`，所以在 T3 里四种 provider 的行为相同。

## 投递

Ryugi 每有一条反馈就运行一次 [deliver.cjs](deliver.cjs)，stdin 是事件 JSON。

- 用 `t3 thread send` 把 `wakeMessage` 发到 `session` 指向的线程。线程忙时 T3 把消息排到下一轮。收到 `started` 或 `queued` 回执就退出 0。
- 线程已归档或 T3 里已经没有这个线程时，退出 10，Ryugi 随即退订。
- 发送失败时，如果线程最新一条用户消息就是这条反馈，说明发送其实已经成功，按送达处理，免得重发一遍；否则退出 1，由 Ryugi 退避重试。

T3 CLI 取 `T3CODE_CLI_PATH`，数据目录取 `T3CODE_HOME`，默认是 `~/.t3`。需要 Node.js 22+。运行 `npm test` 验证。
