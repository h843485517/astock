# A股实时收益追踪器 — 全栈优化执行总结

> 完成时间：2026-03-20  
> 全部 16 项任务均已执行完毕，零 lint 错误。

---

## 已完成任务一览

### 安全方向（P0/P1）

| 任务 | 改动文件 | 核心变更 |
|------|----------|---------|
| Task 1：命令注入修复 | `server.js` | `killPort()` 从 `exec` 改为 `execFile` + 端口合法性校验（1-65535），彻底消除 shell 注入面 |
| Task 4：Chat XSS 加固 | `client/src/pages/Chat.vue` | `renderText()` 补充 `"` → `&quot;`、`'` → `&#39;` 转义，HTML 特殊字符全覆盖 |
| Task 5：改密码后旧 Token 失效 | `src/db/database.js`、`src/routes/auth.js`、`src/middleware/auth.js` | `users` 表新增 `token_version`；改密时 `+1` + 清 Cookie；`requireAuth` 异步比对版本，不匹配返回 401 |
| Task 11：错误信息脱敏 | `src/routes/positions.js` | 4 处 `catch` 块统一返回通用提示，敏感 DB 错误仅记录服务端日志 |

### 性能方向（P1/P2）

| 任务 | 改动文件 | 核心变更 |
|------|----------|---------|
| Task 2：基金行情并行化 | `src/routes/positions.js`、`src/routes/chat.js`、`client/src/pages/Home.vue`、`client/src/pages/Positions.vue` | 串行 `for await` 改为 `Promise.allSettled()`，N 只基金延迟从 N×T 降至 ≈T |
| Task 3：路由懒加载 | `client/src/router/index.js` | 6 个页面从静态 `import` 改为动态 `() => import()`，首屏 bundle 体积显著下降 |
| Task 6：auth/me 缓存 | `client/src/router/index.js`、`client/src/api.js`、`client/src/App.vue` | 模块级 `cachedUser` 缓存，路由守卫跳过重复 HTTP 请求；401 / 登出时自动清除 |
| Task 7：持仓 SSE 断线重连 | `client/src/pages/Home.vue`、`client/src/pages/Positions.vue` | 指数退避重连（3/6/15/30s），超限后提示手动刷新 |
| Task 8：usePositionStream composable | `client/src/composables/usePositionStream.js`（新建）、`Home.vue`、`Positions.vue` | 将重复的 SSE 连接 + 手动刷新逻辑抽取为统一 composable；Home 保留 throttledSnapshot 回调，Positions 保留 checkAlerts 回调 |
| Task 9：持仓 CRUD 减少 DB 回查 | `src/routes/positions.js` | POST 路由用 insertId + 输入构造返回对象；PUT 路由合并 existing + updates 返回，各省一次 SELECT |
| Task 10：Chat SSE 改为 POST | `src/routes/chat.js`、`client/src/pages/Chat.vue` | `GET /api/chat/stream` → `POST`，参数移至请求体；前端改用 `fetch` + `ReadableStream` 读取，`AbortController` 中断，消除 URL 长度限制风险 |

### 运维方向（P2/P3）

| 任务 | 改动文件 | 核心变更 |
|------|----------|---------|
| Task 12：Docker 日志 + 资源限制 | `docker-compose.yml` | json-file 日志滚动（50MB×5）；`memory: 1g` 防 OOM 拖垮宿主机 |
| Task 13：Health Check 端点 | `server.js`、`docker-compose.yml` | 新增 `GET /api/health`（无需认证）；Docker healthcheck 每 30s 探测，失败 3 次标记 unhealthy |
| Task 14：冗余索引 + 死依赖清理 | `src/db/database.js`、`package.json` | 移除 `daily_snapshots` 重复 INDEX（UNIQUE KEY 已覆盖）；`pnpm remove browser-sync` |
| Task 15：全局错误边界 | `client/src/main.js` | `app.config.errorHandler` 捕获组件树内未处理异常，防白屏并展示 Toast |
| Task 16：文档同步 | `docs/security.md`、`docs/api.md`、`docs/concurrency.md`、`docs/deployment.md`、`docs/deployment-aliyun.md`、`README.md` | 6 个文档全面更新，覆盖本次所有优化内容 |

---

## 关键技术决策说明

### token_version 异步验证
`requireAuth` 中间件在 JWT 签名验证后，异步发起 DB 查询比对版本号，通过 `.then().catch()` 避免阻塞同步 next()，保持中间件响应速度。

### usePositionStream onData 回调
composable 在 `onmessage` 更新 `positions`/`quotes` ref 后立即调用 `onData`。Vue 响应式计算（`enriched` computed）在同一微任务内完成，`onData` 中的 `enriched.value` 已反映最新数据，`checkAlerts` 可正常工作。

### fetch + ReadableStream 替代 EventSource
解决了多轮对话历史超长时 URL 越界问题；`AbortController.abort()` 比 `EventSource.close()` 更干净地中断正在进行的 fetch；POST 方法也更符合"写操作"的语义。

---

## 未改动的设计说明

- HTTP 部署约束（无 HTTPS/HSTS）：CSP 和 HSTS 仍由 `HTTPS_ENABLED` 环境变量动态控制，未强制开启
- Docker 桥接 IP（`172.17.0.1`）：按用户约束保持硬编码
- MySQL 连接池 / Cluster fork 数：保持现有配置，未引入 Redis
