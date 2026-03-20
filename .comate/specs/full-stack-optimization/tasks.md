# A 股实时收益追踪器 — 全栈优化任务清单

- [x] Task 1: 修复 `server.js` 命令注入风险（安全 P0）
    - 1.1: 在 `killPort()` 函数入口处添加 `PORT` 纯数字校验（parseInt + isNaN + 范围 1-65535），校验失败直接 resolve 不执行 shell 命令
    - 1.2: 将 `exec(\`lsof -ti:${port}\`)` 改为 `execFile('lsof', ['-ti:' + port])` 避免 shell 拼接
    - 1.3: 将 `exec(\`kill -9 ${pids.join(' ')}\`)` 改为 `execFile('kill', ['-9', ...pids])` 避免 shell 拼接

- [x] Task 2: 基金行情串行请求改为并行（性能 P1）
    - 2.1: 修改后端 `src/routes/positions.js` 中 `buildPositionPayload()` 的基金循环，改用 `Promise.allSettled()` 并行请求所有基金行情
    - 2.2: 修改后端 `src/routes/chat.js` 中同样的基金串行循环，改为 `Promise.allSettled()` 并行
    - 2.3: 修改前端 `client/src/pages/Home.vue` 中 `refresh()` 的基金串行循环，改为 `Promise.allSettled()` 并行
    - 2.4: 修改前端 `client/src/pages/Positions.vue` 中 `manualRefresh()` 的基金串行循环，改为 `Promise.allSettled()` 并行

- [x] Task 3: 前端路由懒加载（性能 P1）
    - 3.1: 将 `client/src/router/index.js` 中 6 个页面的静态 `import` 改为 `() => import(...)` 动态导入
    - 3.2: 移除顶部 6 行静态 import 语句，在 routes 数组中直接使用动态导入

- [x] Task 4: Chat 页面 XSS 加固（安全 P1）
    - 4.1: 修改 `client/src/pages/Chat.vue` 中 `renderText()` 函数，补充双引号 `"` → `&quot;` 和单引号 `'` → `&#39;` 的转义

- [x] Task 5: 修改密码后旧 Token 失效（安全 P1）
    - 5.1: 在 `src/db/database.js` 的 `initDatabase()` 中添加 ALTER TABLE 为 `users` 表增加 `token_version INT UNSIGNED NOT NULL DEFAULT 0` 列（兼容存量数据，catch 1060）
    - 5.2: 修改 `src/routes/auth.js` 的登录接口（POST /login），在 `jwt.sign` payload 中加入 `tokenVersion: user.token_version || 0`
    - 5.3: 修改 `src/routes/auth.js` 的注册接口（POST /register），在 `jwt.sign` payload 中加入 `tokenVersion: 0`
    - 5.4: 修改 `src/routes/auth.js` 的改密码接口（PUT /password），更新密码后同时执行 `UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?`，使所有旧 Token 失效
    - 5.5: 修改 `src/middleware/auth.js` 的 `requireAuth` 中间件，verify 成功后查库比对 `decoded.tokenVersion` 与数据库中 `token_version`，不匹配则返回 401
    - 5.6: 在 `src/db/database.js` 中新增 `getTokenVersion(userId)` 方法，查询用户 token_version 字段

- [x] Task 6: 前端 auth/me 缓存减少冗余请求（性能 P2）
    - 6.1: 在 `client/src/router/index.js` 中引入模块级缓存变量 `let cachedUser = null`
    - 6.2: 修改 `beforeEach` 守卫，若 `cachedUser` 已有值则跳过 api.getMe()，直接放行
    - 6.3: 在 api.getMe() 成功时赋值 `cachedUser`，catch 401 时清除 `cachedUser = null` 并跳转登录
    - 6.4: 导出 `clearAuthCache()` 函数供登出时调用清除缓存

- [x] Task 7: 前端持仓 SSE 添加断线重连机制（性能 P2）
    - 7.1: 在 `client/src/pages/Home.vue` 中为持仓 SSE 的 `onerror` 添加指数退避重连逻辑（复用大盘 SSE 的退避策略：初始 3s，梯度 3/6/15/30s，超出次数回退到手动刷新）
    - 7.2: 在 `client/src/pages/Positions.vue` 中做同样的持仓 SSE 重连改造

- [x] Task 8: 抽取 usePositionStream composable 消除重复代码（性能 P2）
    - 8.1: 新建 `client/src/composables/usePositionStream.js`，封装持仓 SSE 连接创建、onmessage 数据处理、onerror 重连、manualRefresh 函数、positions/quotes ref
    - 8.2: 重构 `client/src/pages/Home.vue`，移除重复的 connectPositionSSE 和 refresh 逻辑，改为调用 usePositionStream composable
    - 8.3: 重构 `client/src/pages/Positions.vue`，移除重复的 connectPositionSSE 和 manualRefresh 逻辑，改为调用 usePositionStream composable
    - 8.4: 确保两个页面各自的额外逻辑（Home 的 throttledSnapshot、Positions 的 checkAlerts）仍正常工作

- [x] Task 9: 持仓 CRUD 查询精简（性能 P2）
    - 9.1: 修改 `src/routes/positions.js` POST 路由，插入后基于输入数据 + insertId 构造返回对象，移除 `db.getPositionById(result.id)` 回查
    - 9.2: 修改 `src/routes/positions.js` PUT 路由，更新成功后将鉴权查获得的 `existing` 对象与 `updates` 合并返回，移除第 3 次 `db.getPositionById(id)` 回查

- [x] Task 10: Chat SSE 从 GET 改为 POST-based 流式传输（性能 P2）
    - 10.1: 修改后端 `src/routes/chat.js`，将 `/stream` 从 `router.get` 改为 `router.post`，从 `req.body` 中读取 `message`、`codes`、`history` 参数
    - 10.2: 修改前端 `client/src/pages/Chat.vue` 的 `sendMessage()`，将 `new EventSource(url)` 替换为 `fetch('/api/chat/stream', { method: 'POST', body, credentials: 'include' })` + `response.body.getReader()` 读取 SSE 流
    - 10.3: 适配流式读取：按 `\n\n` 分割 SSE 事件，解析 `data:` 前缀，复用现有的 onmessage 处理逻辑（token 拼接、[DONE] 结束、error 处理）
    - 10.4: 保留 `stopStreaming()` 功能：使用 `AbortController` 中断 fetch 请求

- [x] Task 11: 错误信息脱敏（安全 P2）
    - 11.1: 修改 `src/routes/positions.js` 所有 `catch(err) { fail(res, err.message, 500) }` 为 `console.error('[Positions]', err); fail(res, '操作失败，请稍后重试', 500)`

- [x] Task 12: Docker Compose 增加资源限制和日志管理（运维 P2）
    - 12.1: 在 `docker-compose.yml` 的 app 服务中添加 `logging` 配置：`driver: json-file`，`max-size: 50m`，`max-file: 5`
    - 12.2: 在 `docker-compose.yml` 的 app 服务中添加 `deploy.resources.limits`：`memory: 1g`

- [x] Task 13: 添加 Health Check 端点（运维 P2）
    - 13.1: 在 `server.js` 中 API 路由之前添加 `GET /api/health` 端点，返回 `{ code: 0, data: { status: 'ok', uptime: process.uptime() } }`
    - 13.2: 在 `docker-compose.yml` 的 app 服务中添加 `healthcheck` 配置：`test: ["CMD-SHELL", "wget -qO- http://localhost:${PORT:-3000}/api/health || exit 1"]`，interval 30s，timeout 5s，retries 3

- [x] Task 14: 移除冗余索引和死依赖（P3）
    - 14.1: 修改 `src/db/database.js` DDL 中 `daily_snapshots` 表定义，移除 `INDEX idx_user_date (user_id, snap_date)`（UNIQUE KEY 已覆盖）
    - 14.2: 执行 `pnpm remove browser-sync` 移除无用的 devDependency

- [x] Task 15: 前端全局错误边界（P3）
    - 15.1: 修改 `client/src/main.js`，在 `createApp(App)` 后添加 `app.config.errorHandler` 全局错误处理，console.error 并展示 Toast 提示

- [x] Task 16: 同步更新项目文档
    - 16.1: 更新 `docs/security.md` — 新增 token_version 机制、Chat XSS 加固、positions 错误脱敏、`/api/health` 端点说明
    - 16.2: 更新 `docs/concurrency.md` — 新增基金行情并行化说明（`Promise.allSettled` 替代串行循环）
    - 16.3: 更新 `docs/api.md` — `/api/chat/stream` 从 GET 改为 POST（请求体格式）、新增 `/api/health` 端点、`PUT /api/auth/password` 新增 token 失效说明
    - 16.4: 更新 `docs/deployment.md` — docker-compose 新增 logging、healthcheck、资源限制配置说明
    - 16.5: 更新 `docs/deployment-aliyun.md` — docker-compose 配置变化说明
    - 16.6: 更新 `docs/environments.md` — 如有新增环境变量或行为变化，同步更新
    - 16.7: 更新 `README.md` — 安全说明新增 token_version/XSS 加固/错误脱敏；API 概览 `/api/chat/stream` 改为 POST；新增 `/api/health`
