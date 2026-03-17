<template>
  <div class="lp-page">
    <div class="lp-card">
      <!-- 品牌 -->
      <div class="lp-brand">
        <span class="lp-logo">📈</span>
        <h1 class="lp-title">A股收益追踪器</h1>
        <p class="lp-subtitle">实时掌握你的投资动态</p>
      </div>

      <!-- Tab -->
      <div class="lp-tabs">
        <button class="lp-tab" :class="{ active: mode === 'login' }" @click="switchMode('login')">登录</button>
        <button class="lp-tab" :class="{ active: mode === 'register' }" @click="switchMode('register')">注册</button>
      </div>

      <!-- 表单 -->
      <form class="lp-form" @submit.prevent="handleSubmit" autocomplete="off">
        <div class="lp-field">
          <label class="lp-label">用户名</label>
          <input
            v-model="username"
            class="lp-input"
            type="text"
            name="lp-username"
            placeholder="3-20 位字母、数字或下划线"
            autocomplete="new-password"
            maxlength="20"
            required
          />
        </div>

        <div class="lp-field">
          <label class="lp-label">密码</label>
          <input
            v-model="password"
            class="lp-input"
            type="password"
            name="lp-password"
            :placeholder="mode === 'register' ? '至少 8 位，含大小写字母和数字' : '请输入密码'"
            autocomplete="new-password"
            maxlength="100"
            required
          />
          <!-- 注册密码强度 -->
          <div v-if="mode === 'register' && password" class="lp-strength">
            <span :class="pwdChecks.length ? 'ok' : 'no'">{{ pwdChecks.length ? '✓' : '✗' }} ≥8位</span>
            <span :class="pwdChecks.upper  ? 'ok' : 'no'">{{ pwdChecks.upper  ? '✓' : '✗' }} 大写</span>
            <span :class="pwdChecks.lower  ? 'ok' : 'no'">{{ pwdChecks.lower  ? '✓' : '✗' }} 小写</span>
            <span :class="pwdChecks.digit  ? 'ok' : 'no'">{{ pwdChecks.digit  ? '✓' : '✗' }} 数字</span>
          </div>
        </div>

        <!-- 错误提示 -->
        <div v-if="errorMsg" class="lp-error">{{ errorMsg }}</div>

        <button type="submit" class="lp-btn" :disabled="loading">
          <span v-if="loading" class="lp-spinner"></span>
          {{ mode === 'login' ? '登录' : '注册并登录' }}
        </button>
      </form>

      <p class="lp-tip">
        {{ mode === 'login' ? '还没有账号？' : '已有账号？' }}
        <a href="#" @click.prevent="switchMode(mode === 'login' ? 'register' : 'login')">
          {{ mode === 'login' ? '立即注册' : '返回登录' }}
        </a>
      </p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';
import { useRouter } from 'vue-router';
import * as api from '../api.js';

const router   = useRouter();
const mode     = ref('login');
const username = ref('');
const password = ref('');
const errorMsg = ref('');
const loading  = ref(false);

function switchMode(m) {
  mode.value     = m;
  errorMsg.value = '';
  username.value = '';
  password.value = '';
}

const pwdChecks = computed(() => ({
  length: password.value.length >= 8,
  upper:  /[A-Z]/.test(password.value),
  lower:  /[a-z]/.test(password.value),
  digit:  /[0-9]/.test(password.value),
}));

async function handleSubmit() {
  errorMsg.value = '';
  loading.value  = true;
  try {
    if (mode.value === 'login') {
      await api.login({ username: username.value, password: password.value });
    } else {
      await api.register({ username: username.value, password: password.value });
    }
    router.push('/');
  } catch (err) {
    errorMsg.value = err.message || '操作失败，请稍后重试';
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
/* 整页背景：浅灰 */
.lp-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: #f5f6fa;
}

/* 白色卡片 */
.lp-card {
  width: 100%;
  max-width: 420px;
  background: #ffffff;
  border-radius: 18px;
  padding: 44px 40px 36px;
  box-shadow: 0 4px 32px rgba(0, 0, 0, 0.10), 0 1px 4px rgba(0,0,0,0.06);
}

/* 品牌 */
.lp-brand { text-align: center; margin-bottom: 32px; }
.lp-logo  { font-size: 44px; display: block; margin-bottom: 10px; }
.lp-title {
  font-size: 22px;
  font-weight: 700;
  color: #1a1a2e;
  margin: 0 0 4px;
  font-family: -apple-system, 'PingFang SC', sans-serif;
}
.lp-subtitle { font-size: 13px; color: #9098b1; margin: 0; }

/* Tab */
.lp-tabs {
  display: flex;
  background: #f0f2f8;
  border-radius: 10px;
  padding: 4px;
  margin-bottom: 28px;
}
.lp-tab {
  flex: 1;
  padding: 9px;
  border: none;
  background: transparent;
  color: #9098b1;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  border-radius: 7px;
  transition: all 0.2s;
  font-family: inherit;
}
.lp-tab.active {
  background: #ffffff;
  color: #1a1a2e;
  font-weight: 700;
  box-shadow: 0 1px 6px rgba(0,0,0,0.10);
}

/* 表单 */
.lp-form   { display: flex; flex-direction: column; gap: 18px; }
.lp-field  { display: flex; flex-direction: column; gap: 7px; }
.lp-label  { font-size: 13px; color: #4a5568; font-weight: 600; }

.lp-input {
  padding: 11px 14px;
  background: #f8f9fc;
  border: 1.5px solid #e2e8f0;
  border-radius: 9px;
  color: #1a1a2e;
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s, box-shadow 0.2s;
  font-family: inherit;
}
.lp-input:focus {
  border-color: #4f9cf9;
  background: #fff;
  box-shadow: 0 0 0 3px rgba(79, 156, 249, 0.12);
}
.lp-input::placeholder { color: #b0b8cc; }

/* 密码强度 */
.lp-strength {
  display: flex;
  gap: 12px;
  font-size: 12px;
  flex-wrap: wrap;
}
.ok { color: #10b981; font-weight: 500; }
.no { color: #cbd5e0; }

/* 错误 */
.lp-error {
  background: #fff5f5;
  border: 1px solid #fed7d7;
  color: #e53e3e;
  padding: 9px 13px;
  border-radius: 7px;
  font-size: 13px;
}

/* 提交按钮 */
.lp-btn {
  width: 100%;
  padding: 13px;
  background: linear-gradient(135deg, #4f9cf9, #2d7dd2);
  color: #fff;
  border: none;
  border-radius: 9px;
  font-size: 15px;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin-top: 4px;
  transition: opacity 0.2s, transform 0.15s, box-shadow 0.2s;
  box-shadow: 0 3px 14px rgba(79, 156, 249, 0.35);
  font-family: inherit;
}
.lp-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 5px 20px rgba(79,156,249,0.45); }
.lp-btn:disabled { opacity: 0.55; cursor: not-allowed; transform: none; }

/* 小 spinner */
@keyframes lp-spin { to { transform: rotate(360deg); } }
.lp-spinner {
  width: 15px; height: 15px;
  border: 2px solid rgba(255,255,255,0.4);
  border-top-color: #fff;
  border-radius: 50%;
  animation: lp-spin 0.7s linear infinite;
}

/* 底部提示 */
.lp-tip {
  text-align: center;
  margin: 18px 0 0;
  font-size: 13px;
  color: #9098b1;
}
.lp-tip a { color: #4f9cf9; text-decoration: none; font-weight: 500; }
.lp-tip a:hover { text-decoration: underline; }

@media (max-width: 640px) {
  .lp-card  { padding: 32px 20px 28px; }
  .lp-logo  { font-size: 36px; }
  .lp-title { font-size: 19px; }
}
</style>