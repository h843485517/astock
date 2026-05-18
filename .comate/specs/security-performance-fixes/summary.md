# 安全与性能问题修复 — 实现总结

## 修复内容

### Task 1：Auth 中间件 token_version 校验逻辑

**文件**：`src/middleware/auth.js`

- 将 `requireAuth` 改为 `async function`
- 用 `await db.getTokenVersion()` 替换 `.then()/.catch()` 链式调用
- DB 故障时返回 `500` 而非 `.catch(() => next())` 放行
- 安全效果：数据库不可用期间不再允许已撤销的 Token 通过认证

---

### Task 2：Cluster 多 Worker 重复轮询行情 API

**文件**：`server.js`、`src/services/quoteService.js`

- `quoteService.js` 新增 `updateIndexFromIPC(result)` 函数并导出
- `server.js` 主进程：启动 `primaryPoll` 轮询（链式 `setTimeout`），通过 `cluster.workers[id].send()` IPC 广播给所有 Worker
- `server.js` Worker（生产模式）：移除 `startIndexPolling`，改为监听 `process.on('message')` 接收行情数据
- 性能效果：4 核 CPU 下行情 API 调用次数从 4 次/周期降为 1 次/周期

---

### Task 3：轮询定时器重叠

**文件**：`src/services/quoteService.js`

- `startIndexPolling` 中 `setInterval` → 链式 `setTimeout`
- 效果：上一次 poll 完成后才等待 intervalMs，不会产生并发重叠请求

---

### Task 4：uncaughtException 后进程继续运行

**文件**：`server.js`

- `uncaughtException` 处理由"仅打印日志"改为"打印日志 + 触发 `gracefulShutdown`"
- 效果：进程异常崩溃后优雅关闭 HTTP 连接和 DB 连接池，由 Cluster 自动重启新 Worker

---

### Task 5：killPort 在多 Worker 下竞态执行

**文件**：`server.js`

- `killPort` 调用条件从 `!DOCKER_ENV` 改为 `IS_DEV && !DOCKER_ENV`
- 效果：生产 Cluster 模式下多个 Worker 不再竞相 `kill -9` 其他进程

---

### Task 6：文档更新

| 文件 | 更新内容 |
|------|----------|
| `docs/security.md` | token_version 校验描述改为"await 同步查库"，DB 故障行为改为"返回 500" |
| `docs/concurrency.md` | 进程模型章节补充 IPC 广播行情的架构说明和代码流程 |
| `docs/nodejs-high-concurrency.md` | 可优化项表格新增"多 Worker 重复轮询"已解决条目 |
