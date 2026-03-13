# A股追踪器优化：Vite + SSE + 后端加固

- [x] 任务 1：引入 Vite，将前端迁移为 Vue SFC 工程
    - 1.1: 安装依赖：`vite`、`@vitejs/plugin-vue`（devDependency）；更新 package.json scripts：`dev` 改为 concurrently 同时跑 `nodemon server.js`（后端，3000） 和 `vite`（前端，5173）；`build` 为 `vite build`；`start` 改为先 build 再启动 node
    - 1.2: 在项目根目录创建 `vite.config.js`：配置 `@vitejs/plugin-vue`，`root: 'client'`，`build.outDir: '../dist'`，`server.proxy` 将 `/api` 代理到 `http://localhost:3000`
    - 1.3: 创建 `client/` 目录作为前端源码根目录，包含 `index.html`（Vite 入口，引用 `/src/main.js`）、`src/main.js`（createApp + router + mount）、`src/router/index.js`（Vue Router 4 hash 模式）、`src/api.js`（与原 public/js/api.js 等价的 ES module 版本）
    - 1.4: 将 `public/js/components/MarketIndex.js` 迁移为 `client/src/components/MarketIndex.vue`（SFC，去掉 CDN 全局变量写法，改用 `import { defineComponent, computed } from 'vue'`）
    - 1.5: 将三个页面迁移为 SFC：`client/src/pages/Home.vue`、`client/src/pages/Positions.vue`、`client/src/pages/AddPosition.vue`，各页面 `<script setup>` 语法，import 替代全局挂载
    - 1.6: 将 `public/css/style.css` 移至 `client/src/assets/style.css`，在 `main.js` 中 import；更新 `server.js`：生产环境改为托管 `dist/` 目录（`express.static('dist')`），SPA 回退改为 `dist/index.html`

- [x] 任务 2：用 SSE 替换大盘指数轮询
    - 2.1: 在 `src/services/quoteService.js` 中新增 `startIndexPolling(intervalMs)` 函数：内部维护 `setInterval` 每 10s 抓取一次大盘行情，将结果存入模块级变量 `latestIndexData`，通过 `EventEmitter` 广播 `index-update` 事件
    - 2.2: 在 `src/routes/quote.js` 中新增 `GET /api/market-index/stream` SSE 路由：设置响应头 `Content-Type: text/event-stream`，连接建立时立即推送当前 `latestIndexData`；订阅 `index-update` 事件持续推送；客户端断开时取消订阅，防止内存泄漏
    - 2.3: 在 `server.js` 启动时调用 `startIndexPolling()`，确保服务启动后立即开始后台抓取
    - 2.4: 在前端 `client/src/pages/Home.vue` 中：移除大盘指数的 `setInterval` 轮询逻辑，改为在 `onMounted` 创建 `new EventSource('/api/market-index/stream')`，`onmessage` 时更新 `indices`；`onUnmounted` 时调用 `eventSource.close()` 关闭连接

- [x] 任务 3：后端加固（安全头 + 压缩 + 限流 + 异常兜底 + 优雅关机）
    - 3.1: 安装生产依赖：`helmet`、`compression`、`express-rate-limit`
    - 3.2: 在 `server.js` 注册 `helmet()`（安全 HTTP 头）和 `compression()`（gzip 压缩），位置在所有路由之前
    - 3.3: 创建 API 限流中间件：`express-rate-limit` 配置 windowMs=15min、max=300 次，仅作用于 `/api` 路由，超限返回 `{code:1, message:"请求过于频繁"}`
    - 3.4: 在 `server.js` 末尾添加未捕获异常兜底：`process.on('uncaughtException')` 和 `process.on('unhandledRejection')` 打印错误日志，防止进程意外崩溃
    - 3.5: 实现优雅关机：监听 `SIGTERM`/`SIGINT`，收到信号后调用 `server.close()` 等待现有连接处理完毕再退出，同时关闭 SQLite 数据库连接

- [x] 任务 4：验证与收尾
    - 4.1: 运行 `npm run build` 验证 Vite 构建无报错，`dist/` 目录生成正确
    - 4.2: 启动生产模式 `npm start`，验证 `/api/market-index/stream` SSE 连接正常，数据推送稳定
    - 4.3: 验证 `npm run dev` 下 Vite HMR 生效（修改 `.vue` 文件浏览器自动热更新），API 代理正常
    - 4.4: 清理 `public/js/` 旧文件（迁移完成后可删除），更新 `.dockerignore` 排除 `client/node_modules`（如有）