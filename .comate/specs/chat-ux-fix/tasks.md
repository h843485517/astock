# AI 投资顾问三项交互缺陷修复（选中标的 / 中断输出 / 智能滚动）

- [x] 任务 1：修复后端"选中标的不生效"问题
    - 1.1 在 `src/routes/chat.js` 的 `GET /stream` 路由中，`buildContext` 调用前，利用已解析好的 `selectedCodes`（已 normalize）构建 `selectedCodesSet`
    - 1.2 当 `selectedCodesSet` 非空时，将 `positions` 过滤为仅包含选中 codes 的条目；未选中任何标时保留全量 `positions`
    - 1.3 将 `filteredPositions` 传入 `buildContext` 替代原来的 `positions`

- [x] 任务 2：前端新增"停止"按钮以支持中断流式输出
    - 2.1 在 `Chat.vue` `<script setup>` 中新增 `stopStreaming()` 函数：关闭 `currentEs`、找到最后一条 streaming 中的 AI 消息追加 `\n\n[已中断]`，重置 `streaming.value = false`
    - 2.2 在输入区底部右侧用 `<div style="display:flex;gap:8px;">` 包裹原发送按钮，并在其前方添加仅 `v-if="streaming"` 显示的"⏹ 停止"按钮，绑定 `@click="stopStreaming"`

- [x] 任务 3：实现智能追底逻辑，修复强制滚动问题
    - 3.1 在 `Chat.vue` 中新增 `isNearBottom()` 辅助函数，判断滚动容器距底部是否 ≤ 80px
    - 3.2 改造 `scrollToBottom(force = false)`：仅当 `force === true` 或 `isNearBottom()` 为真时才执行滚动
    - 3.3 token 到达时调用 `scrollToBottom()`（非强制）；`[DONE]` 事件和发送新消息时调用 `scrollToBottom(true)`（强制）
