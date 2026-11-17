# Ryugi 画板回传到 T3 原线程

在发起评审的 T3 线程中，用裸 `ryugi start --background --no-open --artifact artboard/ID` 新建画板。先登记，再写出可提交的轮次并发送浏览器链接：

```sh
ryugi-t3-watch arm --project "$PWD" --artifact artboard/settings --round layout
```

`--project` 指向包含该画板的 Ryugi 项目根。只读预览直接使用浏览器链接。桥接画板如果已被 Ryugi 原生 watcher 订阅，原生通知仍会送达；存在整项目 Claude Monitor 时应使用独立评审目录。

后台通过 macOS 临时 launchd 任务读取公共轮次查询。提交前后复读本轮，发给登记的 T3 实例与 thread，受理后退出。默认等待 24 小时。可用相同参数执行 `status` 或 `cancel`。注销或重启后，原线程可重新 arm 未完成的登记。原线程显式使用 `arm --again` 可以重新等待已完成且重新开放的轮次。投递回执不明时保留待确认状态，避免自动重发。

源码链接安装到 `~/.local/bin/ryugi-t3-watch`。使用 Python 3 标准库、launchctl、t3 和 ryugi。
