# ryugi-t3：只依赖 Ryugi 导出接口的 T3 反馈桥接（重构并改名）

状态：已批准（2026-11-22），取代 `2026-11-18-t3-level-binding-design.md`。

## 为什么做

桥接把用户在 Ryugi 查看器里点的提交、撤回送回发起它的 T3 线程。它现在有三处复制或重新推导了 Ryugi 的内部逻辑，Ryugi 一改，这三处就可能悄悄失效：

- `events.cjs` 的 `scan` 自己读 `comments.json`、`rounds.json`、`asks.json`，重新判断提交和撤回。Ryugi 导出的 `createCommentWatch` 做的是同一件事，`doctor` 的「事件对照」检查就是在比对这两份实现。
- `selection.cjs` 抄了 Ryugi prompt hook 里的选区格式化代码，靠 `doctor` 的「选区对照」发现差异。
- `doctor` 为了守住这两份复制品，自己也越写越重。

目标是让 Ryugi 升级后桥接不用改代码。只有它依赖的导出接口变了才需要改，而且由自检明确指出是哪一个。

2026-11-22 那次故障（Antigravity 把 skill 链接成 `skills/ryugi-artifacts`，preload 匹配不上启动器路径）已经在 `5c47296` 修掉了，不在本次范围内。

## 目标

- 事件检测、提醒文本、选区文本全部来自 Ryugi 自己的代码，桥接里不再有复制品。
- 依赖的 Ryugi 接触面集中在一个模块里列清楚，`doctor` 逐项检查。
- 整体改名为 `ryugi-t3`。
- 现有行为不变：T3 线程里运行 `start` 自动订阅；只把提交和撤回送到线程，未读评论跟在提交消息后面；回合结束时触发云端发布；线程归档后清理订阅；自检不通过就暂停转发并通知线程。

## 非目标

- 给 Ryugi 上游提可插拔投递的建议。以后再说。
- 补发后台进程停止期间发生的提交（见「取舍」）。
- 换投递方式。继续用 `t3 thread send`。

## 反目标

- 不靠解析 T3 内部 item id 这类私有格式来拿线程或会话信息。
- 不为旧名字保留兼容代码。只有一个用户，切换时一次性迁移。

## 约束

- preload 通过 `NODE_OPTIONS` 加载进 T3 agent shell 里的每一个 node 进程。不是 Ryugi 启动器的进程必须立即返回，preload 自身出错也不能影响宿主。
- `~/.t3/userdata/settings.json` 只能在没有 Antigravity 回合运行时修改（agent-stuff 的规定）。改完后各 provider 要重启才会读到新的环境变量。
- 仍在运行的 provider 进程环境里还是旧的 stub 路径。在它们全部重启之前，旧 stub 文件不能删，否则这些 shell 里的 node 会启动失败。
- 停后台进程只能用 `launchctl remove <label>`，不能按进程名或路径去杀。

## 与 Ryugi 的接触面（全部依赖）

新增 `upstream.cjs`，作为唯一加载 Ryugi 代码的模块，导出下面这些。`doctor` 的「接口」检查按同一份清单逐项核对。

| 类型 | 依赖 | 用途 |
|---|---|---|
| 插件位置 | `~/.local/share/ryugi/install/plugins/pi/plugin`（可用 `RYUGI_T3_PLUGIN` 覆盖） | `ryugi update` 会维护这份插件 |
| 公开 CLI | `start` 的 `--artifact`、`--project-dir`、`--ryugi-session` 参数 | 自动订阅 |
| 公开 CLI | `comment list … --format brief` | 提交消息里内联的摘要 |
| 导出函数 | `comment-watch`：`createCommentWatch`、`wakeMessage`、`unreadCount` | 检测事件、生成提醒文本、统计未读 |
| 导出函数 | `comment-subscriptions`：`projectRoot`、`subscriptionFile`、`aliveFile`、`beat` | 登记桥接自己的监听，撤掉原生订阅 |
| 导出函数 | `agent-event`：`postToServer` | 回合结束时 `/api/cloud/flush` |
| hook 脚本 | `hooks/selection-context.cjs <session> <project>`，stdin 传 `{}` | 选区文本 |
| 文件布局 | `.ryugi/artifacts/.state/*-comment-watch/*.json` 里的 `artifacts` 数组 | 撤掉原生订阅，避免重复投递 |

自动订阅继续解析 `start` 的参数，不改成读取 Ryugi 的原生登记。原因：在 T3 的 Codex 线程里，Ryugi 根本不做原生登记（perch、ai-project-shell 的 `codex-comment-watch/` 下只有桥接自己的文件），读登记的话 Codex 线程就收不到反馈。`start` 的参数是 Ryugi 的公开 CLI，是所有接触面里最稳定的一层。

## 设计

### 1. 事件检测改用 `createCommentWatch`

- 后台进程为每个有订阅的项目保留一个 `createCommentWatch(project)` 实例，每轮用该项目的已订阅产物集合调用一次。
- 只转发 `ryugi-choices` 和 `ryugi-answers` 两类事件（包括 `withdrawn`）。`ryugi-comments` 丢弃：评论不单独发送，跟着下一次提交一起走，这个规则不变。
- 存储里不再保存每个订阅的 `baseline`。持久化的只剩订阅记录（线程、租期、启动器、generation）和待投递队列 `pending`，投递回执的核对逻辑不变。
- 新订阅：后台进程第一次看到某个产物时，它当时的状态就是基线，不产生事件。这和 Ryugi 原生后台进程的行为一样。
- 提醒文本：用事件本身调用 `wakeMessage`，再把命令里的启动器路径换成 agent 运行 `start` 时用的路径（Codex 还要带上 `--ryugi-session`）。替换规则沿用现在的 `rebind`。提交消息后面内联 `comment list --format brief` 的输出，再附上该线程宿主的未读评论；这一步在存储锁外执行，最长 15 秒，执行完之前同一订阅的后续消息排在它后面。这部分逻辑整体保留。
- 宿主对应关系（T3 provider → Ryugi 的宿主键）保留在桥接里，用来统计未读和设置 `AI_AGENT`。

### 2. 选区改为直接运行 Ryugi 的 hook

`selection-context --cwd <dir>` 改为执行 `node <plugin>/hooks/selection-context.cjs <project> <project>`，stdin 传 `{}`，原样输出它的 stdout，然后删掉 `selection.cjs` 里抄来的格式化代码。

### 3. 自动订阅

保留 `preload.cjs` 和 `autosub.cjs`：先按文件名快速判断，再解析真实路径匹配 `skills/artifacts/app`（`5c47296` 的做法），然后解析 `start` 参数并订阅。Claude 继续用 SessionStart hook 写 `CLAUDE_ENV_FILE`。

### 4. 跟随 Ryugi 升级

机制不变：后台进程记录所加载 Ryugi 文件的指纹，指纹一变就以 75 退出，launchd 重新拉起后先跑自检。自检通过就恢复转发；不通过就暂停转发，并给每个订阅线程发一次说明，送达之前一直重试。

`doctor` 删掉「事件对照」和「选区对照」两项，因为已经没有复制品需要比对。保留并按上面的清单更新这几项：插件、启动器、接口、订阅文件路径、入口、内联摘要。选区 hook 存在且能运行，算作「接口」检查的一部分。

### 5. 改名为 `ryugi-t3`

所有名字一次改完：

| 现在 | 改为 |
|---|---|
| 目录 `~/my/tools/ryugi-t3-watch` | `~/my/tools/ryugi-t3` |
| 命令 `ryugi-t3-watch` | `ryugi-t3` |
| 状态目录 `~/.local/state/ryugi-t3-watch` | `~/.local/state/ryugi-t3` |
| stub `~/.local/share/ryugi-t3-watch/preload.cjs` | `~/.local/share/ryugi-t3/preload.cjs` |
| launchd 标签 `local.ryugi-t3.watcher.<hash>` | `local.ryugi-t3.worker.<hash>` |
| 原生登记里的假会话 `codex-comment-watch/ryugi-t3-watch.{json,alive}` | `ryugi-t3.{json,alive}` |
| 环境变量 `RYUGI_T3_WATCH_PLUGIN` | `RYUGI_T3_PLUGIN` |
| agent 看到的提示前缀 `ryugi-t3-watch:` | `ryugi-t3:` |
| `package.json` name、README、测试里的名字 | 同上 |

GitHub：新建私有仓库 `JinJieBeWater/ryugi-t3`，加为 `origin`，暂不推送。

### 6. 切换步骤（一次性，手动执行或写成一次性脚本，不进入代码）

1. 代码改完、测试通过后，在当前目录提交。
2. `launchctl remove` 旧标签，停掉旧的后台进程。
3. `mv` 目录到 `~/my/tools/ryugi-t3`，`mv` 状态目录到 `~/.local/state/ryugi-t3`，并改名存储里的字段（如有）。
4. 运行 `ryugi-t3 install` 写入新 stub。把旧 stub 改写成只加载新的 preload，并在 provider 全部重启后删除。
5. 确认没有 Antigravity 回合在运行后，修改 `settings.json` 里的 `NODE_OPTIONS` 和 Claude 的 `--settings` 路径。
6. 对每个已订阅的项目，删除旧的 `codex-comment-watch/ryugi-t3-watch.{json,alive}`。新的后台进程会写入新名字的文件。
7. 运行 `ryugi-t3 doctor`，再随便触发一次订阅，确认后台进程已启动。
8. 更新 `PATH` 里的命令链接（如果有）和 agent-stuff 中提到旧名字的地方。实施时用 grep 确认。

## 取舍

- **后台进程停止期间的提交不补发。** 检测状态只存在内存里。后台进程只在 Ryugi 升级（重启几秒）、重启机器或订阅清空后才会停，Ryugi 自己的原生后台进程也有同样的缺口。换来的是删掉自己维护的那份检测逻辑和它的对照检查。
- **撤原生订阅仍然要写 Ryugi 的状态文件。** 现在没有别的办法避免重复投递，这一点已经在接触面清单里列出，由「订阅文件路径」检查守着。上游如果以后支持可插拔投递，这部分可以删掉。

## 留给实现者

- 模块怎么拆。只要求 Ryugi 代码只从 `upstream.cjs` 加载。
- 现有测试中针对 `scan` 的用例，改成针对「Ryugi 事件 → 待投递队列 → T3 投递」这条链路。测试继续使用已安装的 Ryugi 插件，不做 mock。
- 存储格式是否顺带精简（去掉 `baseline` 后）。旧记录在切换时一次性迁移，不保留读取旧格式的代码。

## 涉及的产物

本次讨论没有使用 Ryugi 产物。`artboard/veil-adaptive-ui`（`~/my/personal/projects/veil`）只是发现故障的现场，不影响设计。
