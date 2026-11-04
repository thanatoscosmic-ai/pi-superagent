# pi-superagent

以 pi 的最简 `Agent` 执行内核，运行 dsh-superagent 的完整领域模型与授权设计。独立 CLI、GitHub Source、飞书事件适配器、SQLite 状态与本地管理面板；默认运行不需要 DeepSeek Harness 服务。

本项目基于 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的 MIT 源码，并直接依赖 pi 1.5.0 的 `pi-agent-core`、`pi-ai`。原型的 DSH 适配器、React 面板和测试保留为兼容实现。新 pi 宿主与原 DSH 宿主不是每个外围功能都等价；下文明确区分已接通能力与保留的兼容层。

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

在真实终端默认进入 **pi 同款组件构建的工单 TUI**：使用 `@earendil-works/pi-tui` 的多行编辑器、Markdown 流式消息、工具卡片和底部状态栏。目标目录必须是 Git 仓库；请求经过真实 Policy/Eval，只有 accept 才创建 Mandate/Ticket，执行在独立 worktree。不是仅给普通聊天加装饰。问候、咨询等不需要开工单的消息由无工具的对话 Agent 正常回答；编码请求若未满足准入，则解释原因并澄清，不会绕过 Policy 去修改文件。

默认界面保持简洁：聊天显示“你 / Agent”，原始事件 JSON、正常健康详情和空工单占位默认隐藏；工具卡片只显示状态与摘要。底部用紧凑状态栏展示真实任务计数和异常。`/tools expand` 展开工具输出，`/debug on` 查看最近事件、健康详情，`/debug off` 恢复简洁界面；`/ticket <id>` 查看完整授权与工作目录。问候不会在正常聊天中重复显示准入拒绝通知，但异常和需要人工处理事项仍可见。

状态栏实时显示评估数、运行工单、持久化队列、待回写和待人工事项；工单详情显示授权范围、Assignment、Report 和工作目录。`/mode coding` 或 `--direct` 切换为当前目录直接编码，此模式不创建领域工单；界面会明确标记区别。`-p`、管道和 `--plain` 保留纯文本 coding 行为。

```sh
npm start -- "先阅读项目，解释代码结构" --cwd /绝对路径/目标项目
npm start -- -p "修正 README 中指定的错字" --cwd /绝对路径/目标项目
npm start -- -c --cwd /绝对路径/目标项目
npm start -- --direct --cwd /绝对路径/目标项目
npm start -- --plain --cwd /绝对路径/目标项目
npm start -- --cwd /绝对路径/目标项目 --allow-shell
npm start -- --version
```

`-p` 单次纯文本输出；`--plain` 使用普通文本界面。TUI 的 `-c` 恢复 `--state` 中的工单线程和持久化状态；纯文本的 `-c` / `--session` 使用 JSON 会话，位于 `~/.pi-superagent/sessions/`。数据包含代码和对话，应按私密数据保管。

TUI 命令：`/help`、`/status`、`/tickets`、`/ticket <id>`、`/new`、`/pause`、`/resume`、`/stop <id>`、`/retry <id>`、`/mode coding|tickets`、`/shell on|off`、`/exit`。忙碌时 Ctrl+C 中断执行而不撤销工单授权，可 `/resume` 继续；需要永久撤销时用 `/stop`。Shell 开启和模式切换仅在安全空闲状态进行。

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
- **最少人的注意力**：面板优先显示 attention、blocked、failed；明确结果或需要行动时回复。`observe` 记录主动提案但不执行，只有 `auto` 可接受 inferred 工作。

领域核心保留在 `src/core/`，版本化 Policy 在 `src/policy.ts`，存储与副作用队列在 `src/app/store.ts` / `effects.ts`；新宿主在 `src/pi/`。

## 能力边界

新 pi 宿主接通：本地任务、模型结构化评估、独立 worktree、文件/搜索工具、可选 Shell、工单报告与 handback、会话持久化、恢复、并发限制、GitHub Issue/PR 评论与 review/CI 读取、原会话回复、PR 关闭通知、受认证管理面板。飞书适配器读取 OpenAPI 验证消息身份并支持原线程回复，凭据仅由环境变量提供。

角色模型可在 `eval.model` / `executor.model` 中分别设置 `{ "provider": "openai", "model": "模型名" }` 或 `deepseek`，两者共用环境中的接口地址和凭据；不支持的 provider/reasoning effort 会明确拒绝。新 pi 执行器目前拒绝非空 `executor.prepare` 和自定义执行目录，而不是忽略配置；需要准备环境时在授权任务中显式执行，默认 worktree 位于状态目录下。

原型完整领域行为和 DSH 外围实现保留，包括 admission 表、observe/auto、Subscription、策略变更通知、PR follows、版本化提示词与 skills、主 Session 管理工具、DSH 后台 job/subagent 和完整 React 配置面板。保留源码不意味着这些 DSH 特有外围能力全部已接入新 pi CLI；`npm run build:dsh` 构建原兼容宿主。原 DSH 部署说明仍见 [SETUP.md](SETUP.md)。论文中的未来设想没有被标记为已实现。

余弦阈值工具位于 `src/pi/similarity.ts`：对最多 50 个向量的所有配对计算真实余弦标量，降序取上四分位边界；`autoDistanceThreshold` 明确返回 `1 - similarity`，零向量配对跳过。该工具不改变 Policy，当前不是 embedding 记忆系统。

测试使用 pi 的 scripted faux provider，无需付费模型凭据，覆盖真实 agent 工具循环与临时 Git worktree；平台测试使用注入传输。离线通过不能替代真实模型、GitHub 或飞书部署验收。

## 原型思路核对

核对结果：**保留并复用了原型完整领域核心，默认工单 TUI 真实使用它，但仍不是原型全部外围机制的完整迁移。** `src/core/` 和 `src/policy.ts` 与原型逐文件一致，新增 coding 模式不会删改原有 `run/serve` 链路。

| 原型设计 | 工单 TUI 与 `run/serve` | 直接 coding / `--plain` |
| --- | --- | --- |
| Source、Trigger、Thread、Eval、Decision、Mandate、Ticket、Assignment | 真实复用领域模型，TUI 展示评估与执行状态 | 不经领域对象 |
| gate、逐规则评估、observe/auto、Mandate revalidate | 真实执行与状态展示，显式配置不扩权 | 当前操作者直接授权 |
| Subscription 扇出、Correlation 仅上下文、handback | 真实 core / worker 工具与多轮线程输入 | 普通上下文 |
| SQLite、Effects/Outbox、幂等接收及平台回写 | 持久化队列与回写计数 | coding 会话保存 |
| 工单恢复、Assignment 与 Session 分离、并发和暂停 | 状态详情与暂停、恢复、重试、停止操作 | 单 Agent / Ctrl+C |
| 完整主 Session 路由工具、版本化提示词与 skills | DSH 兼容代码保留，pi 宿主尚未全接 | 未接入 |
| DSH 后台 job/subagent、完整 React 设置面板 | 保留原型实现，TUI 不冒称启用 | 未接入 |
| GitHub、飞书 | `serve` 的平台适配器；TUI 不自动启动监听 | 不自动监听平台 |

两种模式共享 pi 模型层与受目录边界约束的 coding 工具。默认工单 TUI 已接入原型领域治理主链路，直接 coding 则明确绕开领域评估；Outbox 永久不可达处理、完整主 Session 路由工具、提示词版本/skills、后台 jobs/subagents、完整 React 设置面板以及飞书历史轮询仍未全部迁移。完整领域源码保留不等于完整外围功能已经迁移，这些缺口没有被标记为实现完成。

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
