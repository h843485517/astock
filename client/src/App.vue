<template>
  <div id="app-root">
    <nav class="nav" v-if="!isLoginPage">
      <div class="nav-brand">
        <span>📈</span>
        <span>A股收益追踪器</span>
      </div>
      <div class="nav-links">
        <router-link to="/">首页</router-link>
        <router-link to="/positions">持仓管理</router-link>
        <router-link to="/history">收益历史</router-link>
        <router-link to="/chat">投资顾问</router-link>
      </div>
      <div class="nav-right">
        <!-- 隐藏金额：直接显示在导航栏 -->
        <button
          class="btn-icon privacy-btn"
          @click="togglePrivacy"
          :title="privacyMode ? '显示金额' : '隐藏金额'"
        >{{ privacyMode ? '🙈' : '👁️' }}</button>

        <!-- 用户管理下拉菜单 -->
        <div v-if="username" class="user-menu" ref="menuRef">
          <button class="user-avatar-btn" @click="menuOpen = !menuOpen" :title="username">
            <span class="user-avatar-icon">{{ username.charAt(0).toUpperCase() }}</span>
            <span class="user-avatar-name">{{ username }}</span>
            <span class="user-avatar-caret" :class="{ open: menuOpen }">▾</span>
          </button>

          <Transition name="dropdown">
            <div v-if="menuOpen" class="user-dropdown">
              <div class="dropdown-header">
                <div class="dropdown-avatar">{{ username.charAt(0).toUpperCase() }}</div>
                <div>
                  <div class="dropdown-username">{{ username }}</div>
                  <div class="dropdown-role">普通用户</div>
                </div>
              </div>
              <div class="dropdown-divider"></div>

              <!-- 暗黑模式 -->
              <button class="dropdown-item" @click="toggleDark">
                <span class="di-icon">{{ darkMode ? '🌙' : '☀️' }}</span>
                <span>{{ darkMode ? '深色模式' : '浅色模式' }}</span>
                <span class="di-badge" :class="darkMode ? 'badge-on' : 'badge-off'">{{ darkMode ? '已开启' : '已关闭' }}</span>
              </button>

              <div class="dropdown-divider"></div>

              <!-- 修改密码 -->
              <button class="dropdown-item" @click="openChangePwd">
                <span class="di-icon">🔑</span>
                <span>修改密码</span>
              </button>

              <div class="dropdown-divider"></div>

              <!-- 退出登录 -->
              <button class="dropdown-item dropdown-item-danger" @click="handleLogout">
                <span class="di-icon">🚪</span>
                <span>退出登录</span>
              </button>
            </div>
          </Transition>
        </div>
      </div>
    </nav>

    <!-- 移动端底部 Tab Bar -->
    <nav class="mobile-tabbar" v-if="!isLoginPage">
      <router-link to="/" class="tabbar-item" :class="{ active: route.path === '/' }">
        <span class="tabbar-icon">🏠</span>
        <span class="tabbar-label">首页</span>
      </router-link>
      <router-link to="/positions" class="tabbar-item" :class="{ active: route.path === '/positions' }">
        <span class="tabbar-icon">📋</span>
        <span class="tabbar-label">持仓</span>
      </router-link>
      <router-link to="/add" class="tabbar-item" :class="{ active: route.path === '/add' }">
        <span class="tabbar-icon">➕</span>
        <span class="tabbar-label">添加</span>
      </router-link>
      <router-link to="/history" class="tabbar-item" :class="{ active: route.path === '/history' }">
        <span class="tabbar-icon">📅</span>
        <span class="tabbar-label">历史</span>
      </router-link>
      <router-link to="/chat" class="tabbar-item" :class="{ active: route.path === '/chat' }">
        <span class="tabbar-icon">🤖</span>
        <span class="tabbar-label">顾问</span>
      </router-link>
    </nav>

    <router-view v-slot="{ Component }">
      <Transition name="page" mode="out-in">
        <component :is="Component" />
      </Transition>
    </router-view>

    <!-- Toast 容器 -->
    <div class="toast-container" id="toast-container"></div>

    <!-- 修改密码弹窗 -->
    <Teleport to="body">
      <div v-if="pwdModal.show" class="modal-mask" @click.self="closePwd">
        <div class="modal-box">
          <div class="modal-header">
            <span class="modal-title">🔑 修改密码</span>
            <button class="btn-icon" @click="closePwd">✕</button>
          </div>
          <div class="modal-body">
            <div class="edit-field">
              <label class="edit-label">原密码</label>
              <input v-model="pwdForm.oldPassword" class="edit-input" type="password" placeholder="请输入原密码" autocomplete="current-password" />
              <span v-if="pwdErrors.oldPassword" class="edit-error">{{ pwdErrors.oldPassword }}</span>
            </div>
            <div class="edit-field">
              <label class="edit-label">新密码</label>
              <input v-model="pwdForm.newPassword" class="edit-input" type="password" placeholder="≥8位，含大小写字母和数字" autocomplete="new-password" />
              <span v-if="pwdErrors.newPassword" class="edit-error">{{ pwdErrors.newPassword }}</span>
            </div>
            <div class="edit-field">
              <label class="edit-label">确认新密码</label>
              <input v-model="pwdForm.confirmPassword" class="edit-input" type="password" placeholder="再次输入新密码" autocomplete="new-password" />
              <span v-if="pwdErrors.confirmPassword" class="edit-error">{{ pwdErrors.confirmPassword }}</span>
            </div>
          </div>
          <div class="modal-footer">
            <button class="btn btn-secondary" @click="closePwd">取消</button>
            <button class="btn btn-primary" @click="submitChangePwd" :disabled="pwdSaving">
              <span v-if="pwdSaving" class="loading-spinner" style="margin-right:4px;"></span>
              确认修改
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { ref, reactive, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import * as api from './api.js';
import { usePrivacy } from './composables/usePrivacy.js';

const route  = useRoute();
const router = useRouter();
const { privacyMode, togglePrivacy } = usePrivacy();

const username    = ref('');
const menuOpen    = ref(false);
const menuRef     = ref(null);
const isLoginPage = computed(() => route.path === '/login');

// ── 暗黑模式 ─────────────────────────────────────────────────
const darkMode = ref(localStorage.getItem('darkMode') === 'true');
function applyDark(val) {
  document.documentElement.classList.toggle('dark', val);
  localStorage.setItem('darkMode', val);
}
function toggleDark() {
  darkMode.value = !darkMode.value;
  applyDark(darkMode.value);
  menuOpen.value = false;
}

// ── 点击外部关闭菜单 ─────────────────────────────────────────
function onClickOutside(e) {
  if (menuRef.value && !menuRef.value.contains(e.target)) {
    menuOpen.value = false;
  }
}

async function fetchUsername() {
  try {
    const res = await api.getMe();
    username.value = res.data?.username || '';
  } catch (_) {
    username.value = '';
  }
}

onMounted(async () => {
  applyDark(darkMode.value);
  document.addEventListener('click', onClickOutside);
  await fetchUsername();
});

// 从登录页跳转到其他页面时重新获取用户名
watch(() => route.path, (newPath, oldPath) => {
  if (oldPath === '/login' && newPath !== '/login') {
    fetchUsername();
  }
});
onUnmounted(() => document.removeEventListener('click', onClickOutside));

async function handleLogout() {
  menuOpen.value = false;
  try { await api.logout(); } catch (_) {}
  username.value = '';
  router.push('/login');
}

// ── 修改密码弹窗 ─────────────────────────────────────────────
const pwdModal  = reactive({ show: false });
const pwdForm   = reactive({ oldPassword: '', newPassword: '', confirmPassword: '' });
const pwdErrors = reactive({});
const pwdSaving = ref(false);

function openChangePwd() {
  menuOpen.value = false;
  Object.assign(pwdForm, { oldPassword: '', newPassword: '', confirmPassword: '' });
  Object.keys(pwdErrors).forEach(k => delete pwdErrors[k]);
  pwdModal.show = true;
}
function closePwd() { pwdModal.show = false; }

async function submitChangePwd() {
  Object.keys(pwdErrors).forEach(k => delete pwdErrors[k]);
  let valid = true;
  if (!pwdForm.oldPassword) { pwdErrors.oldPassword = '请输入原密码'; valid = false; }
  if (!pwdForm.newPassword) { pwdErrors.newPassword = '请输入新密码'; valid = false; }
  if (pwdForm.newPassword && pwdForm.newPassword !== pwdForm.confirmPassword) {
    pwdErrors.confirmPassword = '两次密码不一致'; valid = false;
  }
  if (!valid) return;

  pwdSaving.value = true;
  try {
    await api.changePassword({ oldPassword: pwdForm.oldPassword, newPassword: pwdForm.newPassword });
    window.showToast('密码修改成功，请重新登录', 'success');
    closePwd();
    setTimeout(async () => {
      try { await api.logout(); } catch (_) {}
      username.value = '';
      router.push('/login');
    }, 1500);
  } catch (e) {
    window.showToast(e.message, 'error');
  } finally {
    pwdSaving.value = false;
  }
}

// ── 全局 Toast ────────────────────────────────────────────────
window.showToast = function (message, type = 'info', duration = 3000) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity .3s';
    setTimeout(() => container.removeChild(toast), 300);
  }, duration);
};
</script>

<style scoped>
/* 用户菜单触发器 */
.user-menu { position: relative; }
.user-avatar-btn {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px 5px 5px;
  border: 1px solid var(--border);
  border-radius: 100px;
  background: var(--bg-card);
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  font-family: inherit;
}
.user-avatar-btn:hover { background: var(--bg-card-hv); border-color: var(--border-hv); }
.user-avatar-icon {
  width: 26px; height: 26px;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.user-avatar-name { font-size: 13px; font-weight: 500; color: var(--text-secondary); max-width: 80px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.user-avatar-caret { font-size: 11px; color: var(--text-muted); transition: transform 0.2s; }
.user-avatar-caret.open { transform: rotate(180deg); }

/* 下拉面板 */
.user-dropdown {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 220px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0,0,0,0.12);
  overflow: hidden;
  z-index: 200;
}
.dropdown-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
}
.dropdown-avatar {
  width: 36px; height: 36px;
  border-radius: 50%;
  background: var(--color-primary);
  color: #fff;
  font-size: 15px;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.dropdown-username { font-size: 14px; font-weight: 600; color: var(--text-primary); }
.dropdown-role { font-size: 11px; color: var(--text-muted); margin-top: 1px; }
.dropdown-divider { height: 1px; background: var(--border); margin: 2px 0; }

/* 下拉菜单项 */
.dropdown-item {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 16px;
  background: transparent;
  border: none;
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  text-align: left;
  transition: background 0.12s, color 0.12s;
  font-family: inherit;
}
.dropdown-item:hover { background: var(--bg-card-hv); color: var(--text-primary); }
.dropdown-item-danger:hover { background: rgba(224,53,53,0.08); color: var(--color-rise); }
.di-icon { font-size: 15px; width: 20px; text-align: center; flex-shrink: 0; }
.di-badge {
  margin-left: auto;
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 100px;
  font-weight: 600;
}
.badge-on  { background: #ecfdf5; color: #059669; border: 1px solid #a7f3d0; }
.badge-off { background: #f1f5f9; color: #94a3b8; border: 1px solid #e2e8f0; }

/* 下拉动画 */
.dropdown-enter-active, .dropdown-leave-active { transition: opacity 0.15s, transform 0.15s; }
.dropdown-enter-from, .dropdown-leave-to { opacity: 0; transform: translateY(-6px); }

/* 弹窗（复用全局样式，scoped 补充即可） */
.modal-mask {
  position: fixed; inset: 0;
  background: rgba(15,23,42,0.45);
  backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000; padding: 20px;
}
.modal-box {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: 100%; max-width: 400px;
  box-shadow: 0 8px 40px rgba(0,0,0,0.14);
  animation: modal-in 0.2s ease;
}
@keyframes modal-in {
  from { opacity: 0; transform: scale(0.97) translateY(6px); }
  to   { opacity: 1; transform: scale(1)    translateY(0); }
}
.modal-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.modal-title { font-size: 15px; font-weight: 700; color: var(--text-primary); }
.modal-body  { padding: 20px; display: flex; flex-direction: column; gap: 16px; }
.modal-footer {
  display: flex; justify-content: flex-end; gap: 10px;
  padding: 14px 20px 18px;
  border-top: 1px solid var(--border);
}
.edit-field  { display: flex; flex-direction: column; gap: 6px; }
.edit-label  { font-size: 13px; color: var(--text-secondary); font-weight: 600; }
.edit-input  {
  padding: 10px 13px;
  background: var(--bg-input);
  border: 1.5px solid var(--border);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px; outline: none;
  font-family: inherit;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.edit-input:focus { border-color: var(--color-primary); background: var(--bg-card); box-shadow: 0 0 0 3px rgba(37,99,235,0.10); }
.edit-input::placeholder { color: var(--text-muted); }
.edit-error { font-size: 12px; color: var(--color-rise); }

/* ── 移动端底部 Tab Bar ──────────────────────────────────────── */
.mobile-tabbar { display: none; }

@media (max-width: 640px) {
  .mobile-tabbar {
    display: flex;
    position: fixed;
    bottom: 0; left: 0; right: 0;
    z-index: 200;
    background: var(--bg-card);
    border-top: 1px solid var(--border);
    padding-bottom: env(safe-area-inset-bottom);
    box-shadow: 0 -2px 12px rgba(0,0,0,0.06);
  }
  .tabbar-item {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 8px 4px;
    text-decoration: none;
    color: var(--text-muted);
    font-size: 10px;
    gap: 3px;
    transition: color 0.15s;
    font-family: inherit;
  }
  .tabbar-item.active { color: var(--color-primary); }
  .tabbar-icon { font-size: 20px; line-height: 1; }
  .tabbar-label { font-weight: 500; }
}

/* 暗黑模式下 tabbar */
:global(html.dark) .mobile-tabbar {
  background: #111111;
  border-top-color: #222222;
  box-shadow: 0 -2px 12px rgba(0,0,0,0.5);
}
</style>