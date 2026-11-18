# Ryugi × T3 Code

在 T3 的 Claude、Codex、Pi 或 Antigravity 线程中运行 `ryugi start --artifact artboard/layout`（或 `node …/ryugi.cjs start …`）即绑定该产物。之后的提交、撤回和人类评论会送回原线程。换宿主时跟随线程当前的评论游标。同一产物在另一线程重新打开即转移归属。

```sh
ryugi-t3-watch list
ryugi-t3-watch status --project "$PWD" --artifact artboard/layout
ryugi-t3-watch subscribe --project "$PWD" --artifact artboard/layout --thread THREAD --host Codex
ryugi-t3-watch unsubscribe --project "$PWD" --artifact artboard/layout
ryugi-t3-watch prune
```

首次订阅记录现状，续订保留基线并延期（默认七天，`--ttl` 单位秒）。macOS 的单个按需 launchd 作业按状态目录隔离，空表后退出。状态保存在 `${XDG_STATE_HOME:-~/.local/state}/ryugi-t3-watch`。投递回执不明时核对最近 50 条消息，保留未确认记录供 `status` 查看。

运行需要 Node.js 22+、本机 T3 CLI 和位于 `~/.gemini/config/plugins/ryugi` 的 Ryugi 插件。在源码目录用 `bun install --frozen-lockfile` 安装命令解析依赖。运行 `node --test` 验证桥接，真实 launchd 测试使用临时状态目录。

Codex 0.170 的四项 hook 需要在 `/hooks` 中逐项信任。Antigravity 使用 ACP 包装器，Pi 使用用户扩展软链。
