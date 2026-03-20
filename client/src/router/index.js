import { createRouter, createWebHashHistory } from 'vue-router';
import * as api    from '../api.js';

// 路由级懒加载：按需加载页面组件，减小首屏 bundle 体积
const Home        = () => import('../pages/Home.vue');
const Positions   = () => import('../pages/Positions.vue');
const AddPosition = () => import('../pages/AddPosition.vue');
const Login       = () => import('../pages/Login.vue');
const Chat        = () => import('../pages/Chat.vue');
const History     = () => import('../pages/History.vue');

const routes = [
  { path: '/login',     component: Login,       meta: { public: true } },
  { path: '/',          component: Home },
  { path: '/positions', component: Positions },
  { path: '/add',       component: AddPosition },
  { path: '/chat',      component: Chat },
  { path: '/history',   component: History },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHashHistory(),
  routes,
});

// 登录态内存缓存：避免每次路由跳转都请求 /api/auth/me
let cachedUser = null;

// 全局路由守卫：非公开页面校验登录态
router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  // 已有缓存则直接放行，无需重复请求
  if (cachedUser) return true;
  try {
    const res = await api.getMe();
    cachedUser = res.data || true;
    return true;
  } catch (_) {
    cachedUser = null;
    return '/login';
  }
});

/**
 * 清除登录态缓存（登出或收到 401 时调用）
 */
export function clearAuthCache() {
  cachedUser = null;
}

export default router;