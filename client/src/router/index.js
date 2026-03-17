import { createRouter, createWebHashHistory } from 'vue-router';
import Home        from '../pages/Home.vue';
import Positions   from '../pages/Positions.vue';
import AddPosition from '../pages/AddPosition.vue';
import Login       from '../pages/Login.vue';
import Chat        from '../pages/Chat.vue';
import History     from '../pages/History.vue';
import * as api    from '../api.js';

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

// 全局路由守卫：非公开页面校验登录态
router.beforeEach(async (to) => {
  if (to.meta.public) return true;
  try {
    await api.getMe();
    return true;
  } catch (_) {
    return '/login';
  }
});

export default router;