import { createApp } from 'vue';
import router from './router/index.js';
import App from './App.vue';
import './assets/style.css';

const app = createApp(App);

// 全局错误边界：捕获组件树内未处理的异常，防止白屏
app.config.errorHandler = (err, instance, info) => {
  console.error('[Vue Error]', info, err);
  window.showToast?.('页面发生错误，请刷新重试', 'error');
};

app.use(router).mount('#app');