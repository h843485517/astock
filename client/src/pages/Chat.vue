<template>
  <div class="page chat-page">
    <!-- 标题 -->
    <div class="section-header" style="margin-bottom:16px;">
      <span class="section-title">🤖 AI 投资顾问11</span>
      <span style="font-size:12px;color:var(--text-muted);">模型：{{ modelName }}</span>
    </div>

    <!-- AI 服务不可用提示（对用户展示为 VIP 功能） -->
    <div v-if="ollamaDown" class="info-card vip-card" style="margin-bottom:16px;">
      <div class="vip-card-icon">👑</div>
      <div class="vip-card-title">VIP 专属功能</div>
      <p class="vip-card-desc">AI 投资顾问为高级会员专属功能，当前暂未向您开放。</p>
      <button class="btn btn-secondary vip-retry-btn" @click="handleRetry">刷新重试</button>
    </div>

    <!-- 持仓标的选择器 -->
    <div class="info-card" style="margin-bottom:16px;">
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
        📌 选择要重点分析的标的（历史行情将纳入上下文，可多选）
      </div>
      <div v-if="loadingPositions" class="skeleton-row">
        <div class="skeleton-block" v-for="i in 4" :key="i" style="width:80px;height:28px;border-radius:20px;"></div>
      </div>
      <div v-else-if="allPositions.length === 0" style="font-size:13px;color:var(--text-muted);">
        暂无持仓，<router-link to="/add" style="color:var(--color-primary);">去添加持仓</router-link> 后 AI 可提供更精准的建议
      </div>
      <div v-else class="tag-list">
        <button
          v-for="pos in allPositions"
          :key="pos.code"
          class="pos-tag"
          :class="{ selected: selectedCodes.includes(pos.code) }"
          @click="toggleCode(pos.code)"
        >
          {{ pos.name || pos.code }}
          <span style="font-size:10px;opacity:0.7;margin-left:4px;">{{ pos.code }}</span>
        </button>
      </div>
    </div>

    <!-- 消息列表 -->
    <div class="chat-messages" ref="messagesEl">
      <div v-if="messages.length === 0" class="chat-empty">
        <div style="font-size:32px;margin-bottom:12px;">💬</div>
        <p>向 AI 顾问提问，例如：</p>
        <div class="suggestion-list">
          <button class="suggestion-item" v-for="s in suggestions" :key="s" @click="fillSuggestion(s)">{{ s }}</button>
        </div>
      </div>

      <template v-for="(msg, idx) in messages" :key="idx">
        <!-- 用户消息 -->
        <div v-if="msg.role === 'user'" class="msg-row msg-user">
          <div class="msg-bubble msg-bubble-user">
            <span class="msg-text">{{ msg.content }}</span>
          </div>
        </div>

        <!-- AI 消息 -->
        <div v-else class="msg-row msg-assistant">
          <div class="msg-avatar">🤖</div>
          <div class="msg-bubble msg-bubble-ai">
            <span class="msg-text" v-html="renderText(msg.content)"></span>
            <span v-if="msg.streaming" class="cursor-blink">▋</span>
          </div>
        </div>
      </template>
    </div>

    <!-- 输入区 -->
    <div class="chat-input-area">
      <textarea
        v-model="inputText"
        class="chat-input"
        placeholder="输入你的问题... (Enter 发送，Shift+Enter 换行)"
        rows="3"
        :disabled="streaming"
        @keydown.enter.exact.prevent="sendMessage"
        @keydown.enter.shift.exact="inputText += '\n'"
        maxlength="500"
      ></textarea>
      <div class="chat-input-footer">
        <span style="font-size:11px;color:var(--text-muted);">{{ inputText.length }}/500</span>
        <div style="display:flex;gap:8px;">
          <button v-if="streaming" class="btn btn-secondary" @click="stopStreaming">⏹ 停止</button>
          <button
            class="btn btn-primary"
            @click="sendMessage"
            :disabled="streaming || !inputText.trim()"
            style="min-width:80px;"
          >
            <span v-if="streaming" class="loading-spinner" style="margin-right:4px;"></span>
            {{ streaming ? '思考中' : '发送' }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import * as api from '../api.js';

const modelName = ref(import.meta.env.VITE_OLLAMA_MODEL || 'qwen2.5:3b');

const allPositions    = ref([]);
const loadingPositions = ref(true);
const selectedCodes   = ref([]);
const messages        = ref([]);
const inputText       = ref('');
const streaming       = ref(false);
const ollamaDown      = ref(false);
const messagesEl      = ref(null);

let currentEs = null;

const suggestions = [
  '帮我分析一下当前持仓的风险',
  '今日大盘走势对我的持仓有什么影响？',
  '哪些持仓可以考虑减仓？',
  '给我一些分散投资风险的建议',
];

onMounted(async () => {
  try {
    const res = await api.getPositions();
    allPositions.value = res.data || [];
  } catch (_) {}
  loadingPositions.value = false;
});

onUnmounted(() => {
  if (currentEs) currentEs.close();
});

function toggleCode(code) {
  const idx = selectedCodes.value.indexOf(code);
  if (idx >= 0) selectedCodes.value.splice(idx, 1);
  else selectedCodes.value.push(code);
}

function fillSuggestion(text) {
  inputText.value = text;
}

function handleRetry() {
  messages.value = [];
  ollamaDown.value = false;
}

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

function stopStreaming() {
  if (!streaming.value) return;
  if (currentEs) { currentEs.close(); currentEs = null; }
  const last = [...messages.value].reverse().find(m => m.role === 'assistant' && m.streaming);
  if (last) {
    last.content  += '\n\n[已中断]';
    last.streaming = false;
  }
  streaming.value = false;
}

// 将换行转为 <br>，简单转义 XSS
function renderText(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

async function sendMessage() {
  const msg = inputText.value.trim();
  if (!msg || streaming.value) return;

  // 关闭上一个连接（如有）
  if (currentEs) { currentEs.close(); currentEs = null; }

  messages.value.push({ role: 'user', content: msg });
  inputText.value = '';
  await scrollToBottom(true);

  messages.value.push({ role: 'assistant', content: '', streaming: true });
  // 通过响应式数组索引访问，确保 Vue 3 proxy 能追踪到属性变更并触发视图更新
  const aiMsgIndex = messages.value.length - 1;
  streaming.value = true;
  ollamaDown.value = false;

  const codes = selectedCodes.value.join(',');
  const url   = `/api/chat/stream1?message=${encodeURIComponent(msg)}${codes ? '&codes=' + encodeURIComponent(codes) : ''}`;

  currentEs = new EventSource(url, { withCredentials: true });

  currentEs.onmessage = async (e) => {
    if (e.data === '[DONE]') {
      messages.value[aiMsgIndex].streaming = false;
      streaming.value = false;
      currentEs.close();
      currentEs = null;
      await scrollToBottom(true);
      return;
    }
    try {
      const obj = JSON.parse(e.data);
      if (obj.error === 'OLLAMA_NOT_AVAILABLE') {
        messages.value = [];
        streaming.value  = false;
        ollamaDown.value = true;
        currentEs.close();
        currentEs = null;
        return;
      }
      if (obj.error) {
        messages.value = [];
        streaming.value  = false;
        ollamaDown.value = true;
        currentEs.close();
        currentEs = null;
        return;
      }
      if (obj.token) {
        messages.value[aiMsgIndex].content += obj.token;
        await scrollToBottom();
      }
    } catch (_) {}
  };

  currentEs.onerror = () => {
    if (streaming.value) {
      const cur = messages.value[aiMsgIndex];
      // 若尚无任何内容则视为服务不可用，触发 VIP 提示
      if (!cur.content) {
        cur.streaming    = false;
        streaming.value  = false;
        ollamaDown.value = true;
      } else {
        cur.content  += '\n\n[连接中断]';
        cur.streaming = false;
        streaming.value = false;
      }
    }
    currentEs.close();
    currentEs = null;
  };
}
</script>

<style scoped>
.chat-page { display: flex; flex-direction: column; height: calc(100vh - 56px - 48px); }

@media (max-width: 640px) {
  .chat-page {
    height: auto;
    min-height: calc(100dvh - var(--nav-height) - 68px - env(safe-area-inset-bottom));
  }
  .chat-input-area {
    position: sticky;
    bottom: 0;
    border-radius: 0;
    border-left: none;
    border-right: none;
    border-bottom: none;
    margin: 0 -12px;
    padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
    box-shadow: 0 -2px 12px rgba(0,0,0,0.06);
  }
}

/* 信息卡片 */
.info-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 14px 16px;
}
.warn-card { border-color: #fde68a; background: #fffbeb; }

/* VIP 功能提示卡片 */
.vip-card {
  border-color: #fbbf24;
  background: linear-gradient(135deg, #fffbeb 0%, #fef3c7 100%);
  text-align: center;
  padding: 28px 20px 22px;
}
.vip-card-icon  { font-size: 36px; margin-bottom: 10px; }
.vip-card-title { font-size: 16px; font-weight: 700; color: #92400e; margin-bottom: 8px; }
.vip-card-desc  { font-size: 13px; color: #78350f; margin-bottom: 16px; line-height: 1.6; }
.vip-retry-btn  { font-size: 12px; color: #92400e; border-color: #fbbf24; background: rgba(255,255,255,0.6); }
.vip-retry-btn:hover { background: rgba(255,255,255,0.9); }

/* 代码块 */
.code-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: #f1f5f9;
  border: 1px solid #e2e8f0;
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 12px;
  color: #1e40af;
}
.code-line { line-height: 1.8; }

/* 标的 Tag 列表 */
.tag-list { display: flex; flex-wrap: wrap; gap: 8px; }
.pos-tag {
  padding: 5px 12px;
  border-radius: 100px;
  border: 1px solid var(--border);
  background: var(--bg-input);
  color: var(--text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.2s;
}
.pos-tag:hover   { border-color: var(--color-primary); color: var(--color-primary); }
.pos-tag.selected {
  background: rgba(79, 156, 249, 0.15);
  border-color: var(--color-primary);
  color: var(--color-primary);
  font-weight: 600;
}

/* 消息列表 */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 8px 0 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-height: 200px;
}

.chat-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 40px 20px;
  color: var(--text-muted);
  font-size: 14px;
  flex: 1;
}
.suggestion-list { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; margin-top: 12px; }
.suggestion-item {
  padding: 7px 14px;
  border-radius: 100px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-secondary);
  font-size: 13px;
  cursor: pointer;
  transition: all 0.2s;
}
.suggestion-item:hover { border-color: var(--color-primary); color: var(--color-primary); background: #eff6ff; }

/* 消息气泡 */
.msg-row { display: flex; align-items: flex-start; gap: 10px; }
.msg-user      { flex-direction: row-reverse; }
.msg-assistant { flex-direction: row; }

.msg-avatar {
  width: 32px; height: 32px;
  border-radius: 50%;
  background: #eff6ff;
  border: 1px solid #bfdbfe;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px;
  flex-shrink: 0;
}

.msg-bubble {
  max-width: 75%;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  font-size: 14px;
  line-height: 1.7;
  word-break: break-word;
}
.msg-bubble-user {
  background: linear-gradient(135deg, var(--color-primary), var(--color-primary-dk));
  color: #fff;
  border-bottom-right-radius: 4px;
}
.msg-bubble-ai {
  background: var(--bg-card);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
}
.msg-text { white-space: pre-wrap; }

/* 打字光标 */
@keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: 0; } }
.cursor-blink { animation: blink 0.8s infinite; color: var(--color-primary); margin-left: 2px; }

/* 输入区 */
.chat-input-area {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 12px;
  box-shadow: var(--shadow-card);
}
.chat-input {
  width: 100%;
  background: transparent;
  border: none;
  color: var(--text-primary);
  font-size: 14px;
  font-family: inherit;
  resize: none;
  outline: none;
  line-height: 1.6;
}
.chat-input::placeholder { color: var(--text-muted); }
.chat-input-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 8px;
}
</style>