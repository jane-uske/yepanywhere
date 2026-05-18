# Aidc-pageAgent 插件 SOP

## 目标

Aidc-pageAgent 插件只负责从当前业务页面拿到足够定位代码的页面上下文，并把上下文交给 Yep 内嵌会话。仓库查找、拉代码、改代码、提代码、建迭代和部署都由 agent 按 MCP 能力完成。

插件不应该自己创建任务系统，也不应该在页面里实现一套独立 agent 流程。

## 角色边界

- Chrome 插件：采集当前 tab、产品识别、页面路由、选中元素、少量 DOM 和样式线索；承载 Yep iframe。
- Yep host：复用 Yep 的新会话和已有会话能力；首条消息把页面上下文包装成 agent 指令。
- Agent：按提示词使用 code 平台、o2、yuque 等 MCP 完成代码定位和交付。

## 准备工作

1. 安装 CLI：

   ```sh
   tnpm i -g @ali/aidc-page-agent
   ```

2. 启动 Yep host，建议固定端口 `3460`：

   ```sh
   aidc-page-agent --port 3460
   ```

3. Chrome 打开扩展管理页，开发者模式加载插件目录：

   ```text
   /Users/rare/kimi-page-agent-extension
   ```

4. 打开插件设置页，把 Aidc-pageAgent URL 配成：

   ```text
   http://localhost:3460
   ```

5. 确认 agent 侧已登录或可用这些 MCP：

   ```text
   code 平台 MCP
   o2 MCP
   yuque MCP
   ```

## 标准使用流程

1. 打开要修改的业务页面。

2. 打开 Chrome 侧边栏里的 `Aidc-pageAgent`。

3. 点击 `刷新上下文`，确认插件识别到产品、代码组、页面路径等信息。

4. 点击 `选择元素`。

5. 回到业务页面，点击需要修改的页面元素。

6. 插件会把 selection 传给 Yep。侧边栏状态应显示已接收选中元素。

7. 在新会话输入框里描述需求，例如：

   ```text
   把这个卡片标题字号调小一点
   ```

8. 发送后，新会话首条消息会带上页面上下文和执行约束。

9. 会话开始后，业务页面上的选中框会自动隐藏。

10. 后续继续对话时，直接正常说需求即可，不会再重复追加完整执行约束。

## 当前会话里的行为

- 插件外层的 `选择元素` 始终会打开一个新的 Yep 新会话 iframe，再开始选择元素。
- 已有会话中继续输入消息时，消息会按原文发送，不再自动带一整段页面上下文。
- 如需重新定位页面元素，应从插件外层重新点击 `选择元素`，生成新的定位上下文和新会话。

## 产品和仓库定位规则

Alime：

- 代码组：`https://code.alibaba-inc.com/aidc-mefe`
- 识别信号：Alime 运行时、页面全局配置、菜单页信息、相关域名等。

Xspace：

- 代码组：`https://code.alibaba-inc.com/aidc-xspace`
- 识别信号：Xspace/XP 域名、运行时资源、micro app、页面标题或相关资源路径等。
- 对 hash 路由页面，会提取最后一段作为仓库模糊检索线索。

例子：

```text
/index.htm#/system/oms/pbx-new/operation-dashboard
```

提取结果：

```json
{
  "routePath": "/system/oms/pbx-new/operation-dashboard",
  "repoHint": "operation-dashboard",
  "searchTerms": ["operation-dashboard", "pbx-new"]
}
```

这里不是写死 `operation-dashboard`。规则是泛化提取 hash 路由最后一段。只有页面已被识别为 Xspace 时，这个线索才会作为 Xspace 仓库检索提示使用。

## Agent 执行 SOP

agent 收到首条上下文后按这个顺序执行：

1. 先看当前 workspace 是否已经有对应仓库。

2. 如果 workspace 没有，再通过 code 平台 MCP 在产品对应代码组里搜索。

3. 找到仓库后下载或拉取代码。

4. 根据需求定位相关文件并修改。

5. 涉及迭代、部署、发布时使用 o2 MCP。

6. 涉及产品文档、业务说明、规范时使用 yuque MCP。

7. 代码仓库相关操作使用 code 平台 MCP。

8. 最后说明改动、验证结果和后续事项。

## 发送给 Agent 的最小上下文

首条消息会尽量只包含定位代码所需信息：

- tab 标题和 URL
- 产品识别结果和代码组
- shell 类型、origin、pathname、环境
- Alime 当前页面和应用信息
- Xspace 路由线索，如 `routePath`、`repoHint`、`searchTerms`
- 选中元素的 tag、文本、class、CSS module 线索、少量属性
- 元素尺寸、关键 computed style、selector、owner container

当前不会把完整 DOM 或完整截图塞进 prompt。

## 常见问题

### 侧边栏黑屏或 localhost 拒绝连接

先确认 CLI 正在运行：

```sh
aidc-page-agent --port 3460
```

再到插件设置页确认 URL 是 `http://localhost:3460`，保存后重新打开侧边栏。

### iframe 被网关或 CSP 拦截

设置页保存 URL 时会调用 preflight。若 preflight 失败，优先检查：

- URL 是否是 Yep host 的 origin 或完整 session URL
- 网关是否允许 iframe
- 网关是否代理 `/api/ws`
- 服务端是否允许 `chrome-extension:` frame ancestor

### 插件没有识别出产品

先点击 `刷新上下文`。如果仍然是 unknown，补充该产品的域名、运行时全局变量或资源路径识别规则。

### Xspace 没有仓库线索

确认页面 URL 是否有 hash 路由，例如：

```text
#/system/xxx/yyy
```

如果 XP 页面不是这种路由结构，需要补充新的路由或运行时采集规则。

### 页面选中框没有消失

发送首条消息后 Yep 会通知插件停止 picker。如果仍残留，刷新业务页面或重新加载插件。开发时优先检查侧边栏是否收到 `YEP_KPA_PROMPT_SENT`。

## 开发阶段约定

- 默认不跑全量 `pnpm typecheck`、`pnpm build:bundle` 或发包。
- 小改优先做代码审查和轻量语法检查。
- 需要发布时再执行完整检查、构建、`tnpm publish` 和 GitLab 推送。

## 相关文档

- 技术协议和 iframe 接入细节：`docs/kimi-page-agent.md`