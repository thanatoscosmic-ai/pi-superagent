# pi-superagent

以 pi 的最简 `Agent` 执行内核，运行 dsh-superagent 的完整领域模型与授权设计。独立 CLI、GitHub Source、飞书事件适配器、SQLite 状态与本地管理面板；默认运行不需要 DeepSeek Harness 服务。

本项目基于 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 MIT 源码，并直接依赖 pi 1.5.0 的 `pi-agent-core`、`pi-ai`、`pi-tui`。原型的 DSH 适配器、React 面板和测试保留为兼容实现。新 pi 宿主与原 DSH 宿主不是每个外围功能都等价；下文明确区分已接通能力、保留的兼容层，以及尚未迁移的部分。

## 安装与快速开始

要求 Node.js 24+、npm 和 Git。GitHub 服务模式还需已认证的 `gh`。克隆仓库后自行安装，不使用全局安装：

```sh
git clone https://github.com/thanatoscosmic-ai/pi-superagent.git
cd pi-superagent
npm install
cp .env.example .env
```

编辑仓库根目录 `.env`，填写 `OPENAI_BASE_URL`、`OPENAI_MODEL` 和 `OPENAI_API_KEY`。`.env` 已被 Git 忽略，不要提交真实凭据。`npm install` 自动构建；禁用安装脚本时手动运行 `npm run build`。

```sh
npm start -- --cwd /绝对路径/目标项目
```

启动器自动读取安装仓库的 `.env`，已有环境变量优先；`--cwd` 指定目标目录。使用 `npm start` 未指定 `--cwd` 时，目标是 pi-superagent 仓库；直接运行启动脚本则保持调用者当前目录。

## 界面

在真实终端默认进入 **pi 同款组件构建的工单 TUI**：使用 `@earendil-works/pi-tui` 的多行编辑器、Markdown 流式消息、逐工具渲染的调用卡片和两行脚注。目标目录必须是 Git 仓库；请求经过真实 Policy/Eval，只有 accept 才创建 Mandate/Ticket，执行在独立 worktree。不是仅给普通聊天加装饰。问候、咨询等不需要开工单的消息由无工具的对话 Agent 正常回答；编码请求若未满足准入，则解释原因并澄清，不会绕过 Policy 去修改文件。

界面与 pi 的交互模式逐项对齐：

- **顶部**：pi 的半块像素 logo、版本号，以及按宽度自动裁剪的快捷键提示（`Esc` 中断、`/` 命令、`@` 文件、`Ctrl+O` 工具、`Shift+Enter` 换行、`/help` 帮助）。Apple Terminal 等画不好半块的终端自动退回文字形。
- **对话**：用户消息是整行底色块；助手回复是**无标签**的 Markdown（标题、列表、表格、代码高亮都走 pi 的渲染器）；报告、通知、系统提示各有独立样式。
- **工具调用**：每个调用是一张带底色的卡片，标题行按工具渲染——`read 路径:起-止`、`edit 路径`（折叠时直接给出 `-`/`+` 预览）、`write 路径`（显示写入内容）、`bash 命令`、`glob 模式 in 目录`、`grep /模式/ in 目录`。运行中、成功、失败使用三种不同底色；超过 1 秒才显示 `Took 4.2s`；`Ctrl+O` 或 `/tools expand` 展开参数与完整输出。
- **编辑器**：上下各一条分隔线（`borderMuted`），忙碌时旋转指示器与状态直接嵌在上边框（`── ⠋ 工作中 (Esc 中断) ──`），暂停时显示静态 `⏸ 已暂停`。
- **脚注**：第一行左是 `目录 (分支)`、右是模型名；第二行是模式、实时计数（评估/运行/队列/回写/待办）、当前工单和异常提示。没有计数时只显示「就绪」。
- **终端集成**：标题写为 `目录名 · pi-superagent`，并向支持 OSC 7501 的终端上报 idle/working/blocked 状态。

原始事件 JSON、正常健康详情、工单 worker 的内部消息（授权 JSON、`工单输入 …`、`开始执行本工单 …`）和协议工具（`orchestrator_report`、`trigger_handback`）默认不进入对话，只在 `/debug on` 里可见。工单进度显示为工具卡片，结果只显示一次报告。

## 使用方法

### 键盘

| 按键 | 行为 |
| --- | --- |
| `Enter` | 发送 |
| `Shift+Enter` | 换行 |
| `Esc` | 有任务在跑：中断当前执行（不撤销授权）；空闲：退出；编辑器有内容：先交给编辑器处理（取消补全） |
| `Ctrl+C` | 有任务在跑：中断；否则清空未发送草稿；编辑器为空时连按两次退出 |
| `Ctrl+D` | 编辑器为空时退出 |
| `Ctrl+O` | 展开或折叠所有工具卡片 |
| `↑` / `↓` | 命令历史 |
| `Tab` | 接受补全（`/` 命令、`@` 文件、`/ticket|/stop|/retry` 的工单 id） |

### 命令

| 命令 | 说明 |
| --- | --- |
| `/help` | 命令帮助 |
| `/status` | 模式、目录、模型、Shell、调度、在办计数、工单数与健康摘要 |
| `/tickets` | 工单列表：短 id、状态、标题、更新时间 |
| `/ticket [id]` | 工单详情；省略 id 时取正在运行的、否则最近的未结束工单；支持 id 前缀 |
| `/pause` / `/resume` | 暂停或恢复工单调度（授权与草稿都保留；对话不受影响） |
| `/stop <id>` | 停止工单并撤销授权；对已结束的工单会直接说明 |
| `/retry <id>` | 重试执行失败或受阻的工单 |
| `/mode coding\|tickets` | 切换「当前目录直接编码」与「工单模式」，仅在空闲时可用 |
| `/shell on\|off` | 开关命令执行，仅在空闲时可用；开启后仍是**非沙箱** |
| `/tools [expand\|collapse]` | 展开或折叠工具输出，等同于 `Ctrl+O` |
| `/debug on\|off` | 显示最近 50 条事件、完整健康详情与工单详情 |
| `/new` | 新建会话线程，并清空当前对话区 |
| `/exit` | 退出 |

领域拒绝（找不到工单、工单已结束、不能重试等）会在界面上换成中文说明，不直接抛英文原文。

### 两种模式

- **工单模式（默认）**：请求进入 `Source → Trigger → Thread → Eval → Decision`，accept 后生成 Mandate/Ticket，在独立 worktree 中由 worker 执行，结构化报告 `ready` 才算完成。适合「改一个仓库里的东西」，改动不落在你的工作目录。
- **coding 模式**（`/mode coding` 或 `--direct`）：不经过领域评估与工单，直接在当前目录用同一套受目录边界约束的文件工具编辑。适合交互式改代码。两种模式的界面都会明确标记当前模式。

### 常用启动方式

```sh
npm start -- "先阅读项目，解释代码结构" --cwd /绝对路径/目标项目
npm start -- -p "修正 README 中指定的错字" --cwd /绝对路径/目标项目
npm start -- -c --cwd /绝对路径/目标项目
npm start -- --direct --cwd /绝对路径/目标项目
npm start -- --plain --cwd /绝对路径/目标项目
npm start -- --cwd /绝对路径/目标项目 --allow-shell
npm start -- --version
```

`-p` 单次纯文本输出；`--plain` 使用普通文本界面；`-p`、管道与 `--plain` 均为纯文本 coding 路径。TUI 的 `-c` 恢复 `--state` 中的工单线程与持久化状态（含对话历史）；纯文本的 `-c` / `--session` 使用 JSON 会话，位于 `~/.pi-superagent/sessions/`。数据包含代码和对话，应按私密数据保管。

从任意目标项目目录也可启动，保持当前工作目录并读取安装仓库配置：

```sh
node /绝对路径/pi-superagent/scripts/pi-superagent.mjs
```

验证与更新：

```sh
npm run check
git pull
npm install
```

## 工单与服务模式

```sh
npm start -- run "把 README 中指定的拼写错误改为正确文本" --cwd /绝对路径/目标仓库
```

任务在独立 Git worktree 中执行，不覆盖原工作目录；结果显示 worktree 路径与工单状态。首次无配置的本地运行会添加本地 `operator` 授权；显式 `--config` 不会自动改写允许名单或规则。默认仅启用受目录边界约束的文件工具。需要运行测试、Git 提交或创建 PR 时，显式添加 `--allow-shell`。Shell **不是操作系统沙箱**，只能用于可信仓库与受控账户；建议容器、独立凭据和最小 GitHub 权限。Shell 子进程过滤包含 KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL 的环境变量，工具输出对已知秘密原文脱敏；不支持依赖 `GH_TOKEN` / `GITHUB_TOKEN` 的 Shell 认证，`gh` 可使用系统钥匙串。HOME/PATH 仍保留，无法防止未知文件凭据、编码泄露或网络外传。

服务模式：

```sh
export PI_SUPERAGENT_TOKEN=设置一个至少32字符的随机访问令牌
npm start -- serve --cwd /绝对路径/目标仓库 \
  --repository owner/repo --bot bot-login --allowed trusted-login \
  --config examples/pi-settings.json --allow-shell
```

面板默认只监听 `127.0.0.1:8787`。API 使用 `Authorization: Bearer <令牌>`；页面提供令牌输入。配置文件不包含模型或平台密钥。`--allowed` 使用 GitHub 原生用户名，飞书允许名单使用飞书自己的 ID，二者不映射。

飞书服务需设置 `FEISHU_BOT_ID`、`FEISHU_VERIFICATION_TOKEN`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`（或 `FEISHU_TENANT_ACCESS_TOKEN`），并在配置中填写 `policy.sources.feishu.allowed`。事件回调路径为 `/webhooks/feishu`；公开部署应通过 HTTPS 反向代理只暴露该路径，管理 API 留在回环地址。回调验证平台 token 并回查 OpenAPI 消息身份；不支持加密回调或历史轮询。

其他命令：

```sh
npm start -- status --state /绝对路径/状态目录
npm start -- stop <ticket-id> --state /绝对路径/状态目录
npm start -- retry <ticket-id> --state /绝对路径/状态目录
npm run check
```

服务持有状态目录锁；运行中 CLI 的 `status/stop/retry` 在设置 `PI_SUPERAGENT_TOKEN` 时通过 `--port` 指定的本地 API 转发。未设置令牌时使用面板，或停止服务后执行离线管理命令。独立 `retry` 记录重试，随后启动 `serve` 执行。

## 借鉴了原型哪些设计

`src/core/` 与 `src/policy.ts` 和原型逐文件一致，领域行为不是重新实现，而是原样运行。下表说明每一条设计在新宿主中如何落地。

| 原型设计 | 在新 pi 宿主中的落地 |
| --- | --- |
| **Source → Trigger → Thread**：事件按线程归并，Source 自己维护读位置、丢弃机器人自己的消息 | `src/pi/sources.ts` 的 GitHub/飞书适配器只负责把平台事件翻译成 Trigger；归并、去重、幂等由 `Engine.receive` 与 SQLite 完成，重启不重放 |
| **Thread 内一次只跑一个 Eval，期间到达的消息合并成下一批** | `src/core/evals.ts` 原样运行；TUI 的「评估 N」计数来自 `threads.active()` |
| **Gate + Assessment 两层评估**：确定性门禁判断身份/提及/准入表，模型逐条判断启用规则 | `src/policy.ts` 的 `gate` 与 `assessmentOutcome` 原样运行；pi 宿主用 `src/pi/assessment.ts` 把模型输出约束成结构化 `submit_assessment` 调用 |
| **Mandate 不可变、只由 accept 创建、只由人的 stop 撤回、恢复前 revalidate** | 原样运行；`/stop`、`/retry`、`/resume` 走 `Engine` 的对应命令，TUI 只读展示 |
| **Ticket / Assignment / Session 三层分离** | `Ticket`（授权工作单元）与 `Assignment`（一次执行）在 core；`Session` 由 `src/pi/executor.ts` 的 `pi_session` 表持久化，worker 崩溃恢复靠它 |
| **Subscription 扇出上下文、Correlation 只加上下文、handback 交还超范围请求** | worker 拥有 `thread_follow`、`thread_unrelated`、`trigger_handback` 工具，均调用 core 的对应命令；授权不因扇出扩大 |
| **Effects/Outbox**：事务内记录待执行副作用，提交后执行，失败的按退避重试 | `src/app/effects.ts` 原样运行；pi 宿主的评估、启动、投递、回写都是 effect，TUI 的「队列」「回写」就是这些计数 |
| **observe / auto 接受模式**：inferred 候选在 observe 下只记录「would accept」 | 原样运行；配置 `eval.mode`，`auto` 才真正接受推断工作 |
| **admission 表**：按接收范围、发送者是否在名单、是否 @ 决定 explicit/inferred/ignore | 原样运行在 `src/policy.ts` 的 gate 里；pi 宿主把本地来源的 scope 固定为 `row: 'default'` |
| **Policy 版本与变更通知**：规则/模式/来源变更时丢弃进行中的 Eval 并通知受影响工单 | 原样运行；pi 的 `/shell`、配置写入都经过 `Runtime.configure`，由它触发 `policyChanged` |
| **后台 job / subagent 不占记录、不误报 waiting** | **未迁移**：pi 的 Agent 没有 DSH 的后台 job 语义，worker 一次 turn 内同步完成；长命令用 bash 工具的超时控制 |
| **"主 Session 只路由，不等待"** | pi 宿主把主 Session 换成「对话 Agent + 评估器」：手机端 `Engine` 的路由职责由确定性流程承担，取代 `orchestrator_route` 的多候选批量决策 |
| **版本化提示词与 skills**（`prompts/`、`skills/`、覆盖与默认更新标记） | **未迁移**：`prompts/`、`skills/` 目录保留给兼容宿主；pi 宿主的系统提示词在 `src/pi/executor.ts`、`assessment.ts`、`terminal-controller.ts` 中以内联模板生成 |
| **主 Session 管理工具**（`orchestrator_route`、`orchestrator_eval_decide`、`orchestrator_prompts_save` 等） | **部分迁移**：pi 宿主把主 Session 的职责收窄为「评估 + 对话」，路由由确定性流程完成；管理操作改为 TUI 命令与 HTTP API |
| **完整 React 配置面板**（Overview/Source/Trigger/Eval/Execution/Settings 六个页签） | **未迁移**：保留源码（`npm run build:dsh`），pi 宿主的 `serve` 提供精简面板 + TUI `/status`、`/tickets`、`/debug on` |
| **执行环境变量、prepare 命令、gh/lark 包装脚本** | **部分迁移**：pi 执行器拒绝非空 `executor.prepare` 与自定义目录，worktree 由 `git worktree` 在状态目录下创建；不使用包装脚本 |
| **成员同步、Source 字段校验、setup 探针** | **未迁移**：pi 宿主用 `--allowed` 与配置文件直接给名单，不做自动同步 |
| **面板的「三问」与阶段表**（是否需要我 / 系统是否健康 / 一条工作的历史） | TUI 以脚注 + `/status` + `/ticket` 覆盖前两问，`/debug on` 与事件缓存覆盖第三问，不提供多页签面板 |

结论：**领域内核与治理链路是原型原样复用，外围宿主能力按 pi 的能力重新实现或明确标注未迁移。** 没有把保留源码当作已接入功能。

## 设计原理

核心链路：

```text
Source → Trigger → Thread → Eval → Decision
                                  ↓ accept
                             Mandate + Ticket
                                  ↓
                              Assignment
                                  ↓
                         pi Agent + worktree
                                  ↓
                          Report → Outbox → Source
```

- **授权与执行分离**：确定性 Policy gate 判断身份、提及、来源和准入表；模型 assessor 逐条判断启用规则、实施意图和明确目标。只有 accept 生成不可变 Mandate，worker 只能执行其 scope。
- **生命周期分离**：Ticket 是授权工作单元，Assignment 是一次执行，Session 是 pi 上下文；停止工单撤销授权，失败可重试，同线程人的后续消息可在同一 Mandate 下恢复，恢复要 revalidate。
- **Thread 作为一致性边界**：每线程一个 Eval，消息批合并；Subscription 扇出上下文，Correlation 只关联上下文、不路由或授权；超范围消息 handback 重新评估。
- **可靠性先于模型**：SQLite 事务同时保存领域记录和待执行 effects；幂等 Trigger、持久 Outbox、顺序回写、退避重试、工作目录锁与崩溃恢复不依赖模型记住状态。
- **pi 只做最小内核**：`Agent.prompt` / 工具循环 / 消息事件 / follow-up 注入承担执行；领域 Engine 决定何时开工、暂停、终止和回复。普通模型输出不自动视为完成，worker 必须结构化报告 `ready`。
- **最少人的注意力**：默认只显示异常与待人工；正常健康、空工单与内部事件不占空间。`observe` 记录主动提案但不执行，只有 `auto` 可接受 inferred 工作。

领域核心在 `src/core/`，版本化 Policy 在 `src/policy.ts`，存储与副作用队列在 `src/app/store.ts` / `effects.ts`；新宿主在 `src/pi/`。

## 能力边界

新 pi 宿主接通：本地任务、模型结构化评估、独立 worktree、文件/搜索工具、可选 Shell、工单报告与 handback、会话持久化与恢复、并发限制、GitHub Issue/PR 评论与 review/CI 读取、原会话回复、PR 关闭通知、受认证管理面板。飞书适配器读取 OpenAPI 验证消息身份并支持原线程回复，凭据仅由环境变量提供。

角色模型可在 `eval.model` / `executor.model` 中分别设置 `{ "provider": "openai", "model": "模型名" }` 或 `deepseek`，两者共用环境中的接口地址和凭据；不支持的 provider/reasoning effort 会明确拒绝。pi 执行器拒绝非空 `executor.prepare` 和自定义执行目录，而不是忽略配置；需要准备环境时在授权任务中显式执行，默认 worktree 位于状态目录下。

余弦阈值工具位于 `src/pi/similarity.ts`：对最多 50 个向量的所有配对计算真实余弦标量，降序取上四分位边界；`autoDistanceThreshold` 明确返回 `1 - similarity`，零向量配对跳过。该工具不改变 Policy，当前不是 embedding 记忆系统。

测试使用 pi 的 scripted faux provider，无需付费模型凭据，覆盖真实 agent 工具循环与临时 Git worktree；平台测试使用注入传输。离线通过不能替代真实模型、GitHub 或飞书部署验收。

## 上游设计文档

原型编号文档保留其原始宿主语境：

- [设计哲学](docs/000-philosophy.md)
- [领域模型](docs/001-domain.md)
- [授权](docs/002-authorization.md)
- [执行](docs/003-execution.md)
- [提示词](docs/004-prompts.md)
- [面板](docs/005-panel.md)
- [部署](docs/006-deployment.md)
- [架构](docs/007-architecture.md)
- [Source 扩展示例](docs/008-cookbook.md)

## 许可

[MIT](LICENSE)。保留 DeepSeek Harness Team 的原始版权；pi 依赖使用其原始 MIT 许可。该项目不是 DeepSeek 或 pi 官方产品。
