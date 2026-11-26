# 08. 测试策略、排障与二次开发手册

> **本章目标**：看懂项目如何在完全不连飞书、不调真实大模型的情况下把完整状态机测透；掌握常见故障的排查路径；提供 4 个最常见二次开发需求的精准改动清单。

---

## 1. 离线回归测试是怎么设计的？（`tests/`）

项目使用 Node.js 22 原生 `node:test` + `node:assert/strict`（通过 `node --import tsx --test tests/*.test.ts` 运行，零额外测试框架依赖），共两个核心回归测试文件：

### 1.1 `tests/workspace.test.ts`（目录与引擎适配回归）
重点验证：
- 新话题未绑定、同话题多角色共享目录、切换目录重置全员 `cliSessionId` 并经重启恢复；
- 忙碌成员与待处理流（`workspaceChangeGuard`）阻止切换目录；
- 历史多目录冲突与缺失目录迁移时绝不回退到 OS cwd；
- `~` 路径、相对路径校验、旧 `workspace` / `CLI_WORKDIR` 弃用告警；
- Claude / Codex 适配器解析 `select_workspace` 工具事件；
- `executeCli` 拦截 `select_workspace` 后自动在新目录以全新原生会话续跑；
- 定时任务创建时的目录快照与启动暂停保护。

### 1.2 `tests/chains.test.ts`（全链路与 MCP 闭环回归）
重点验证：
- **Mock CLI 引擎技巧**（`fakeEngine`，第 57–65 行）：临时把 `codex` 适配器的 `command` 替换成 `process.execPath`（即 `node` 自身），用 `node -e "console.log(JSON.stringify(event))"` 模拟任意流式事件输出！这样既走了真实的 `spawnCli` + `runCli` 进程通信和 `killCli` 逻辑，又完全离线、毫秒级完成。
- **核心链路验证**：
  - `handleTaskResult` 路由澄清、审批、本地产品文档真实性检查与普通讨论；
  - `dispatch_task` 派单与 `returnCollaborationResult` 回传保留目录、发起人与轮次，非 CEO 助理调用被拒；
  - 审批续接中触发澄清、澄清续接中触发派单的多跳链路；
  - 进度卡片发送失败时仍能清理 `activeRuns` 并释放 Session 状态；
  - 真实拉起 `src/mcp/app-tools-server.ts` 子进程对接 `startScheduleApi` 的端到端定时任务管理调用；
  - 定时任务直接执行模式遇到交互/派发工具时正确报错失败。

---

## 2. 常见排障速查表

| 现象 | 常见原因 | 排查与处理方式 |
| --- | --- | --- |
| 启动报错 `角色 xxx 缺少 Skill yyy` | `config/bots.json` 绑定的非 `lark-` Skill 在 `skills/` 下不存在 | 补建 `skills/<name>/SKILL.md`，或从 `bots.json` 对应角色的 `skills` 中移除 |
| 启动报错 `缺少环境变量 FEISHU_...` | `.env` 漏配或 `bots.json` 中未将不用的角色设 `"enabled": false` | 补全凭证，或把不启用的角色加上 `"enabled": false` |
| 飞书群里 @ 机器人无反应 | 飞书后台未开启长连接模式、未订阅 `im.message.receive_v1`，或应用未发布最新版本 | 确认 `pnpm agent-os logs` 中有 `[Bot XXX] 已连接`；检查飞书开放平台事件订阅与版本发布 |
| 点击卡片按钮没反应或报错 | 未订阅 `card.action.trigger`，或操作者不是任务发起人 | 检查飞书后台回调配置；审批/确认/澄清/停止按钮仅允许任务发起人点击 |
| 历史定时任务重启后全部变 `paused` | 旧版 `schedules.json` 缺少 `workspaceDir` 字段 | 编辑 `data/schedules.json` 补上绝对路径 `workspaceDir`（纯讨论填 `""`）并将 `status` 改为 `"active"`，热加载自动恢复 |
| `/resume` 或 `/compact` 提示先选目录 | 当前话题尚未绑定 `workspaceDir` | 先发送 `/cd <项目绝对路径>` 绑定目录 |
| 想单独确认 CLI 或 MCP 是否正常 | 不确定问题出在飞书还是本机 CLI | 先跑 `pnpm probe:cli` 测 CLI 协议，再跑 `pnpm probe:tool` 测 MCP 注入 |

---

## 3. 二次开发改动清单（照单改不漏点）

### 场景 A：新增一个角色 Bot
1. 在飞书开放平台创建应用、开长连接与机器人能力、拉进群。
2. 在 `.env` 中新增该角色的 `APP_ID` / `APP_SECRET`。
3. 在 `config/bots.json` 的 `bots` 数组中追加一条配置（指定 `id`、`defaultCli`、`role`、`skills`、`systemPrompt`）。
4. 若绑定了新自定义 Skill，在 `skills/<name>/SKILL.md` 下编写说明。
5. 重启服务（开发模式改 `bots.json` 会自动热重启）。

### 场景 B：新增一条飞书斜杠命令（例如 `/ping`）
1. **`src/core/command-parser.ts`**：在 `SlashCommand` 联合类型与 `parseCommand()` 中增加命令解析。
2. **`src/app/command-handler.ts`**：在 `handleSessionCommand()` 中增加 `if (command?.name === 'ping') { ... return 'handled'; }`，并同步更新 `/help` 文案。
3. （可选）如果需要触发 CLI 执行，则处理完前置校验后返回 `'continue'`，在 `src/index.ts` 中改写 `taskText` 或执行分支。

### 场景 C：新增一个 OS 级 MCP 控制工具（例如 `request_deploy`）
1. **定义 Schema**：在 `src/core/` 下定义请求参数 Zod Schema（参考 `src/core/approval.ts`）。
2. **注册工具常量**：在 `src/cli/app-tools.ts` 中导出工具名常量及 `CLAUDE_*` 映射名。
3. **注册 MCP Server 工具**：在 `src/mcp/app-tools-server.ts` 中调用 `server.registerTool(...)`。
4. **双引擎事件识别**：
   - `src/cli/claude-adapter.ts`（第 208–250 行）：识别 `mcp__agent_os__<tool>` 并转为 `tool_call` 事件。
   - `src/cli/codex-adapter.ts`（第 184–202 行）：识别 `server === 'agent_os'` 且 `item.tool === <tool>` 并转为 `tool_call` 事件。
5. **决定是否中断 CLI 接管**：
   - **需要暂停等待人工交互**：把工具名加进 `src/cli/runner.ts:127` 的拦截名单、`src/app/task-result.ts:32-34` 的 `INTERACTIVE_TOOLS` 及 `handleTaskResult()` 分支，并在 `src/app/scheduled-task-runner.ts:77` 和 `src/app/product-comment-runner.ts:52` 同步加入禁止列表，同时在 `src/im/card.ts` 和 `src/app/card-action-handler.ts` 补齐卡片与回调。
   - **同步工具（无需暂停 CLI）**：像 `schedule_manage` 一样在 `app-tools-server.ts` 内直接完成调用或请求本地 HTTP API 返回结果即可。
6. **补回归测试**：在 `tests/chains.test.ts` 中用 `fakeEngine` 补充对应闭环用例。

### 场景 D：接入一个新的 AI CLI 引擎（例如 Gemini CLI）
1. 在 `src/cli/types.ts` 中将新引擎 ID 加入 `CliId` 联合类型。
2. 新建 `src/cli/<engine>-adapter.ts`，实现 `CliAdapter` 接口（`buildArgs`、`buildResumeArgs`、`parseEvents`、可选 `buildCompactPlan`）。
3. 在 `src/cli/app-tools.ts` 中补充该引擎的 MCP Server CLI 注入参数函数。
4. 在 `src/cli/registry.ts` 中注册新适配器。
5. 更新 `src/core/bot-registry.ts` 的 `defaultCli` 枚举与 `src/core/command-parser.ts` 的 `parseCliRequest`，以及 `native-sessions.ts` / `native-compact.ts`（如需支持 `/resume` 与 `/compact`）。
