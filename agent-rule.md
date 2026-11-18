在 T3 线程里发起或处理 Ryugi 异步画板评审时遵守：

1. **发起评审**
   - 用裸 `ryugi` 在项目中启动或复用桥接画板：`ryugi start --background --no-open --artifact artboard/<id>`（若项目存在原生 Claude 整项目监听，改用独立评审目录以免双发）。
   - 写出可提交轮次前先登记：`ryugi-t3-watch arm --project <画板项目根> --artifact artboard/<id> --round <轮次ID>`；若宿主未提供 `T3CODE_THREAD_ID`（如 Antigravity）且同实例有多个运行中线程，显式加 `--thread <当前threadId>`。登记成功后再分享浏览器链接。
2. **查看他人画板**
   - 直接打开浏览器链接或只读查询，不执行 `arm`。
3. **收到唤回**
   - 收到 `[ryugi:...]` 通知后，用裸 `ryugi comment list --project-dir <画板项目根> --artifact artboard/<id> --sections groups,rounds --detail --json` 复读当前状态。
   - 仍为 `submitted` 时按最新选择继续任务；若已撤回为 `open`，按需重新 `arm` 并等待新决定。
