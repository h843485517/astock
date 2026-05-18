# 安全与性能问题修复任务计划

- [x] Task 1: 修复 Auth 中间件 token_version 异步校验逻辑
    - 1.1: 将 `requireAuth` 改为 `async function`
    - 1.2: 用 `await db.getTokenVersion()` 替换 `.then()/.catch()` 链式调用
    - 1.3: DB 故障时返回 500，而非 `.catch(() => next())` 放行

- [x] Task 2: 修复 Cluster 多 Worker 重复轮询行情 API
    - 2.1: 在 `src/services/quoteService.js` 中新增 `updateIndexFromIPC(result)` 函数并导出
    - 2.2: 在 `server.js` 主进程分支中，移除 `startIndexPolling` 调用，改为启动 IPC 广播轮询（`primaryPoll` + `setInterval`）
    - 2.3: 在 `server.js` Worker 部分，生产模式下监听 `process.on('message')` 接收 IPC 行情数据；开发模式保持本地 `startIndexPolling`
    - 2.4: 移除 Worker 中原有的 `startIndexPolling(SSE_INTERVAL_MS)` 调用

- [x] Task 3: 修复 quoteService 轮询定时器重叠
- [x] Task 4: 修复 uncaughtException 后进程继续运行
- [x] Task 5: 修复 killPort 在多 Worker 模式下竞态执行
- [x] Task 6: 更新文档
    - 6.1: 更新 `docs/security.md`：token_version 校验描述改为"await 同步查库比对"，DB 故障行为改为"返回 500"
    - 6.2: 更新 `docs/concurrency.md`：在第一层进程模型章节补充 IPC 广播行情的说明
    - 6.3: 更新 `docs/nodejs-high-concurrency.md`：在可优化项表格中标记轮询重叠、uncaughtException、killPort 三项为已解决
