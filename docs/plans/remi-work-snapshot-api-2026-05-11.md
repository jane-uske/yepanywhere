# Remi Work Snapshot API 计划

## 摘要

给 Yep 增加一个面向 Remi 的紧凑工作快照 API，让 Remi 能理解 coding agent 的工作状态，而不是自己去扫 Claude / Codex / Gemini 的原始日志。

这不是新增一个 Yep dashboard。Yep 现在已经掌握项目、会话、进程状态、待审批、工具调用和 git diff。缺的是一个很薄的归一化边界，把这些事实整理成 Remi 可以稳定消费的结构。

配套 Remi 文档：`/Users/rare/Desktop/remi-ai/docs/superpowers/plans/2026-05-11-yep-work-supervisor-integration.md`

## 现实判断

- 当前阶段：Yep 有原始证据，但还没有一等公民的 `WorkSnapshot`。
- 现在可做：本地单用户 API，供 Remi 消费。
- 现在不能过度承诺：无法可靠判断任意 agent 工作是否真的完成了某个产品需求。
- 主要瓶颈：把 session / tool / git 证据映射成保守工作状态，同时避免过度宣称。
- 第一可用版本：Remi 能知道哪些项目动了、哪些任务要看、agent 声称了什么、有哪些证据。

## 产品边界

Yep 应该回答这些事实问题：

- 哪些项目今天有 agent 活动？
- 哪些 session 正在运行、等用户输入、卡住或最近完成？
- 哪些文件变了？
- 跑过哪些工具、命令、测试？
- agent 声称自己完成了什么？
- 这个声称有没有证据支撑？

Yep 不应该像产品经理一样替用户武断判断需求完成。它可以做轻量分类，但必须带 confidence。

## 拟议 API

### `GET /api/remi/work-snapshot`

查询参数：

- `since`：可选 ISO 时间；默认当天本地时间开始。
- `limit`：可选数字；默认 `20`，硬上限 `50`。

响应结构：

```ts
export type RemiWorkSnapshotResponse = {
  generatedAt: string;
  window: {
    since: string;
    until: string;
  };
  attention: WorkSignal[];
  active: WorkSignal[];
  completed: WorkSignal[];
  changedProjects: WorkProjectSummary[];
  dailySummary?: {
    claim: string;
    confidence: "low" | "medium" | "high";
    evidenceCount: number;
  };
};

export type WorkSignal = {
  id: string;
  provider: "claude" | "codex" | "codex-oss" | "gemini" | "opencode" | string;
  projectId: string;
  projectName: string;
  sessionId?: string;
  title: string;
  state:
    | "needs_attention"
    | "running"
    | "claimed_done"
    | "verified_done"
    | "blocked"
    | "stale";
  workType: "feature" | "bugfix" | "refactor" | "test" | "docs" | "unknown";
  agentClaim?: string;
  changedFiles?: Array<{
    path: string;
    status: string;
    staged: boolean;
    linesAdded: number | null;
    linesDeleted: number | null;
  }>;
  verification?: Array<{
    kind: "test" | "typecheck" | "lint" | "build" | "commit" | "approval";
    status: "passed" | "failed" | "unknown";
    label: string;
  }>;
  confidence: "low" | "medium" | "high";
  updatedAt: string;
  nextStep?: string;
  evidenceRefs: Array<{
    kind: "session" | "git" | "tool" | "process";
    label: string;
    href?: string;
  }>;
};

export type WorkProjectSummary = {
  projectId: string;
  projectName: string;
  providerCounts: Record<string, number>;
  changedFileCount: number;
  activeSessionCount: number;
  needsAttentionCount: number;
};
```

### 后续可选 API

`GET /api/remi/work-events?since=...`

这一步应该等 snapshot 质量被证明后再做。第一阶段不需要事件流。

## 当前 Yep 可复用的数据源

第一版只复用 Yep 已有事实，不重新发明采集链路。

- 项目和 session 聚合：`packages/server/src/routes/global-sessions.ts`
- needs-attention / active 分层：`packages/server/src/routes/inbox.ts`
- git status 和单文件 diff：`packages/server/src/routes/git-status.ts`
- session detail 和 messages：`packages/server/src/routes/sessions.ts`
- activity bus：`packages/server/src/subscriptions.ts`
- client 侧 tool summary / renderer contract 可作为分类参考，但 server 响应不能依赖 React 渲染。

## 分类规则

### state

- `needs_attention`：存在 pending tool approval 或 user question。
- `running`：进程状态是 `in-turn`。
- `blocked`：最新终止信号是错误、失败命令、审批拒绝，或 agent 明确说被卡住。
- `claimed_done`：agent 最新回复声称完成，但没有验证证据。
- `verified_done`：completion claim 加至少一个通过的验证信号，或存在 commit 证据。
- `stale`：近期有活动，但无法明确归为 active / done / blocked。

### workType

只做保守启发式分类：

- `bugfix`：标题或 claim 提到 fix、bug、error、regression、failing、crash。
- `feature`：标题或 claim 提到 add、implement、support、create、feature。
- `refactor`：标题或 claim 提到 refactor、cleanup、split、extract、simplify。
- `test`：标题、claim 或 verification 主要围绕测试。
- `docs`：变更主要在 markdown/docs，或 claim 明确说文档。
- `unknown`：默认值，模糊时不要硬猜。

### confidence

- `high`：`verified_done`，且有通过的 test / build / typecheck / commit 证据。
- `medium`：清晰 agent claim + 有意义 changed files，但没有验证。
- `low`：claim 弱、只有活动元信息，或证据冲突。

## 文件规划

### 新增文件

- `packages/shared/src/work-snapshot.ts`
  - 共享响应类型和轻量 helper。
- `packages/server/src/work/workSnapshot.ts`
  - server 侧聚合器和分类器。
- `packages/server/src/routes/remi-work.ts`
  - `GET /api/remi/work-snapshot` route。
- `packages/server/test/work/workSnapshot.test.ts`
  - state、work type、confidence、evidence 映射测试。
- `packages/server/test/routes/remi-work.test.ts`
  - route 测试。

### 修改文件

- `packages/shared/src/index.ts`
  - 导出 work snapshot 类型。
- `packages/server/src/app.ts`
  - 注册 Remi work route。
- 如果路由集中注册，也可能修改 `packages/server/src/routes/index.ts`。
- 如果测试 fixture 需要复用 builder，才考虑轻微调整 `packages/server/test/routes/inbox.test.ts`。

## 实施步骤

### 步骤 1：增加 shared types

- 新增 `packages/shared/src/work-snapshot.ts`。
- 从 `packages/shared/src/index.ts` 导出。
- 类型名保持 Yep 所有，但 Remi 容易读：`RemiWorkSnapshotResponse`、`WorkSignal`、`WorkProjectSummary`。

验收：

- `pnpm --filter @yep-anywhere/shared typecheck` 通过。

### 步骤 2：实现纯分类 helper

- 新增 `packages/server/src/work/workSnapshot.ts`。
- 先做纯函数：
  - `classifyWorkType(input)`
  - `deriveConfidence(input)`
  - `deriveSignalState(input)`
  - `buildNextStep(signal)`
- 先用 unit test 覆盖，不接 live session reader。

验收：

- 测试证明没有 verification 时不会标成 `verified_done`。

### 步骤 3：聚合现有 session / project 数据

- 复用 `ProjectScanner`、session readers、`Supervisor`、`NotificationService` 和 git status 能力。
- 默认不要全量解析每个 session，否则可能变慢。
- MVP 只检查近期 session，并用 `limit` 截断 work signals。

验收：

- snapshot 能在 fixture 里返回 changed projects、active sessions、needs-attention items。

### 步骤 4：抽取轻量 agent claim

- 读取近期 session 的尾部消息。
- 只抽最新 assistant final text 或 task result summary。
- Yep v1 不做 LLM summarization；这个 route 应该确定、便宜、可解释。

验收：

- 如果 session final 说 “implemented X”，并且有 changed files 但没有测试，则 state 是 `claimed_done`，confidence 是 `medium`。

### 步骤 5：增加 route

- 新增 `packages/server/src/routes/remi-work.ts`。
- 注册到 `/api/remi/work-snapshot`。
- 返回有边界的 JSON，不返回原始日志正文。

验收：

- route test 覆盖默认 since-window、非法 query、空状态。

### 步骤 6：和 Remi 本地联调

- 本地启动 Yep。
- 请求 `GET /api/remi/work-snapshot`。
- Remi 设置 `REMI_YEP_BASE_URL` 指向 Yep。
- 确认不打开 Yep UI 时，Remi 也能渲染 mock 或真实 Work Signal Sheet。

验收：

- Remi 能说明什么需要注意、哪些项目变了，而不是读取 Yep 原始 session 文件。

## 非目标

- 不从 Yep 主动推 Remi 通知。
- 不做每日定时报告。
- 不接 iOS / World。
- 不做自动 commit / merge / deploy。
- 不在 Yep 内做 LLM 总结。
- 不做完整需求管理或 issue tracker 语义。

## 风险

- provider 日志格式会漂移。缓解：Remi 不扫原始文件，Yep 基于已有 normalized readers 输出。
- 完成判断过度宣称。缓解：严格区分 `claimed_done` 和 `verified_done`。
- snapshot 变慢。缓解：限制 session 数量，优先读 summary / git status，必要时才读 transcript。
- UI 压力反向污染 Yep。缓解：Yep 只返回证据，Remi 决定表达。

## 第一有用里程碑

第一阶段不是“每日 agent 效率 dashboard”。

真正的第一里程碑是：

> Remi 能真实地说：“我看到今天 yepanywhere 和 remi-ai 都有 agent 活动；remi-ai 有一个任务声称完成但缺测试证据，yepanywhere 有一个会话在等你确认改动。”

这就足够证明接入是真的，而不是假装已经理解了所有产品需求。
