# Ryugi 画板回传到 T3 原线程

在发起评审的 T3 线程中，用裸 `ryugi start --background --no-open --artifact artboard/ID` 新建或复用桥接画板。先登记，再写出可提交的轮次并发送浏览器链接：

```sh
ryugi-t3-watch arm --project "$PWD" --artifact artboard/settings --round layout
```

`--project` 指向包含该画板的 Ryugi 项目根。只读预览直接使用浏览器链接。桥接画板如果已被 Ryugi 原生 watcher 订阅，原生通知仍会送达；存在整项目 Claude Monitor 时应使用独立评审目录。

当宿主未注入 `T3CODE_THREAD_ID`（例如 Antigravity）时，`ryugi-t3-watch` 会在当前 T3 实例仅有一个匹配运行中线程时自动识别，否则要求显式传入 `--thread <threadId>`。

## 子命令

- `arm`：绑定当前 T3 线程与轮次，默认等待 24 小时（`--ttl`）。已完成且重新开放的轮次可用 `--again` 重新登记。
- `status`：查看当前绑定、`jobActive` 与 `lastError`，并在投递回执丢失时核对线程消息以确认是否已送达。
- `cancel`：取消当前 `waiting` 绑定并移除后台 job。
- `list`：列出已追踪的绑定（`--active` 仅看未完成项）。
- `prune`：清理已完成（`delivered` / `cancelled` / `expired`）绑定和孤立状态目录（`--all` 一并清理已失活的 `waiting` 绑定）。`arm` 也会自动清理超过 7 天的已完成历史状态。

后台通过 macOS 临时 `launchd` 任务按自适应间隔（2s → 5s → 10s）读取公共轮次查询（每页最多 100 条）。提交前后复读本轮，发给登记的 T3 实例与 thread，受理后退出。投递回执不明时保留 `uncertain`，避免自动重发，并在后续 `status` / `arm` 时核对线程最近消息。

源码链接安装到 `~/.local/bin/ryugi-t3-watch`。使用 Python 3 标准库、`launchctl`、`t3` 和 `ryugi`。
