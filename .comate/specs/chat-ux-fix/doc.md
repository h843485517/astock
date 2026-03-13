# chat-ux-fix — AI 投资顾问交互体验修复

## 需求背景

AI 投资顾问页面存在三处功能性缺陷，影响正常使用：选中标的不生效、无法中断流式输出、自动滚动阻止用户翻阅历史。

---

## 一、选中标的不生效

### 问题根因
`src/routes/chat.js` 第 50 行从数据库拉取了全量持仓 `positions`，随后第 91 行将其原样传入 `buildContext(positions, quotes, historiesMap)`。  
`buildContext`（`src/services/chatService.js` 第 42 行）遍历全量 `positions` 构建 Prompt，导致 AI 上下文包含所有标的，无论前端是否选中。

### 修复方案
在 `src/routes/chat.js` 构建上下文之前，根据 `selectedCodes` 过滤 `positions`：
- 若前端传入了 `codes` 参数，则将 `positions` 过滤为只包含选中 codes 的条目
- 若未传 `codes`（未选中任何标），则保留全量 `positions`（兜底行为，保持原有语义）

### 影响文件
- **修改** `src/routes/chat.js`：`GET /stream` 路由，在 `buildContext` 调用处前插入过滤逻辑

### 实现细节
```js
// src/routes/chat.js — 在 buildContext 调用前
const selectedCodesSet = (codes && codes.trim())
  ? new Set(selectedCodes)   // selectedCodes 已在上方完成 normalizeStockCode
  : null;

const filteredPositions = selectedCodesSet
  ? positions.filter(p => selectedCodesSet.has(normalizeStockCode(p.code)))
  : positions;

const context = buildContext(filteredPositions, quotes, historiesMap);
```

---

## 二、无法中断流式输出

### 问题根因
`client/src/pages/Chat.vue` 中，`streaming` 为 `true` 时发送按钮被禁用，但整个输入区没有提供任何"终止"操作，用户只能等待 AI 输出完毕。

### 修复方案
在输入区底部（发送按钮旁）添加"停止"按钮，仅在 `streaming === true` 时显示；点击后：
1. 关闭 `EventSource`（`currentEs.close()`）
2. 将当前 AI 消息的 `streaming` 标记置为 `false`，并追加 `\n\n[已中断]` 提示
3. 重置 `streaming.value = false`

### 影响文件
- **修改** `client/src/pages/Chat.vue`：模板输入区 + `<script setup>` 新增 `stopStreaming` 函数

### 实现细节
```vue
<!-- 替换原有发送按钮区域 -->
<div class="chat-input-footer">
  <span style="font-size:11px;color:var(--text-muted);">{{ inputText.length }}/500</span>
  <div style="display:flex;gap:8px;">
    <button v-if="streaming" class="btn btn-secondary" @click="stopStreaming">⏹ 停止</button>
    <button class="btn btn-primary" @click="sendMessage"
      :disabled="streaming || !inputText.trim()" style="min-width:80px;">
      <span v-if="streaming" class="loading-spinner" style="margin-right:4px;"></span>
      {{ streaming ? '思考中' : '发送' }}
    </button>
  </div>
</div>
```

```js
// script setup
function stopStreaming() {
  if (!streaming.value) return;
  if (currentEs) { currentEs.close(); currentEs = null; }
  // 找到最后一条 streaming 中的 AI 消息，追加中断标记
  const last = [...messages.value].reverse().find(m => m.role === 'assistant' && m.streaming);
  if (last) {
    last.content  += '\n\n[已中断]';
    last.streaming = false;
  }
  streaming.value = false;
}
```

---

## 三、自动滚动阻止用户手动翻阅

### 问题根因
`Chat.vue` 的 `currentEs.onmessage` 每收到一个 token 就调用 `scrollToBottom()`（第 222 行），强制将滚动位置锁定在底部，用户向上滑动后会立即被拉回。

### 修复方案
实现"智能追底"逻辑：仅当用户当前已处于消息列表底部附近（距底部 ≤ 80px）时才自动滚动；用户主动上翻后停止自动追底，AI 输出结束（`[DONE]`）时仍强制滚到底部。

### 影响文件
- **修改** `client/src/pages/Chat.vue`：`scrollToBottom` 函数 + token 接收处调用逻辑

### 实现细节
```js
const SCROLL_THRESHOLD = 80; // px

function isNearBottom() {
  const el = messagesEl.value;
  if (!el) return true;
  return el.scrollHeight - el.scrollTop - el.clientHeight <= SCROLL_THRESHOLD;
}

async function scrollToBottom(force = false) {
  await nextTick();
  if (messagesEl.value && (force || isNearBottom())) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  }
}
```

- token 到达时：`await scrollToBottom()`（非强制，用户可翻阅）
- `[DONE]` 或发送新消息时：`await scrollToBottom(true)`（强制滚底）

---

## 预期成果

| 问题 | 修复后行为 |
|------|-----------|
| 选中标的不生效 | AI 上下文仅包含选中标的的持仓及行情，未选中时沿用全量持仓 |
| 无法中断输出 | 流式输出期间显示"停止"按钮，点击立即终止并在气泡内追加 [已中断] |
| 强制滚动到底 | 用户上翻后不再被自动拉回；距底 ≤80px 时继续自动追底；完成时强制回底 |