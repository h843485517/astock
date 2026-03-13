# chat-ux-fix 修复总结

## 完成情况

三个缺陷全部修复，涉及后端路由 1 处、前端组件 1 处。

---

## 修复详情

### 1. 选中标的不生效 (`src/routes/chat.js`)

**根因**：`buildContext` 始终接收数据库全量 `positions`，`codes` 参数仅用于拉取历史行情，未影响 Prompt 内容。

**修复**：将 `selectedCodes` 声明提升至 `if` 块外，在 `buildContext` 调用前新增过滤逻辑：
- 前端传入 `codes` → `filteredPositions` 仅保留选中标的
- 未传 `codes` → 沿用全量持仓（兜底）

---

### 2. 无法中断流式输出 (`client/src/pages/Chat.vue`)

**根因**：`streaming` 期间发送按钮禁用，但没有提供任何终止操作入口。

**修复**：
- 新增 `stopStreaming()` 函数：关闭 `EventSource`、在最后一条 AI 气泡追加 `[已中断]`、重置 `streaming = false`
- 输入区底部添加 `v-if="streaming"` 的 **⏹ 停止** 按钮

---

### 3. 自动滚动阻止手动翻阅 (`client/src/pages/Chat.vue`)

**根因**：每个 token 到达都无条件执行 `scrollToBottom()`，强制覆盖用户的手动滚动位置。

**修复**：
- 新增 `isNearBottom()`：判断容器距底部是否 ≤ 80px
- `scrollToBottom(force = false)`：仅 `force=true` 或已处于底部附近时才滚动
- token 到达 → `scrollToBottom()`（非强制，用户上翻后不受干扰）
- 发送消息 / 收到 `[DONE]` → `scrollToBottom(true)`（强制回底）

---

## 改动文件

| 文件 | 改动类型 |
|------|---------|
| `src/routes/chat.js` | 逻辑修复：selectedCodes 作用域提升 + filteredPositions 过滤 |
| `client/src/pages/Chat.vue` | 功能新增：停止按钮 + stopStreaming 函数 + 智能追底逻辑 |