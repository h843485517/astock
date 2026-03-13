import { ref } from 'vue';

// 模块级单例，所有页面共享同一状态
const privacyMode = ref(localStorage.getItem('privacyMode') === 'true');

export function usePrivacy() {
  function togglePrivacy() {
    privacyMode.value = !privacyMode.value;
    localStorage.setItem('privacyMode', String(privacyMode.value));
  }
  return { privacyMode, togglePrivacy };
}