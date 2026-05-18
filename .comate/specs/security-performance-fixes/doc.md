# 安全与性能问题修复

## 概述

修复代码审查中发现的 4 个安全/性能问题，并同步更新项目文档（security.md、concurrency.md、nodejs-high-concurrency.md）。

---

## 修复项 1：Auth 中间件异步 token_version 校验逻辑

### 问题描述

`src/middleware/auth.js:27-43` 中，`requireAuth` 函数在 JWT 签名验证通过后，调用 `next()` 的时机存在问题：token_version 的校验是异步的（`.then()`），但 `next()` 在 `.then()` 回调内，整体逻辑正确——**不是**先调用 `next()` 再检查。

实际问题是：`.catch(() => { next(); })` — 当 DB 查询失败时直接放行，这意味着如果数据库短暂不可用，所有已过期/被撤销的 Token 都能通过认证。

### 修复方案

将 `requireAuth` 改为 `async` 函数，使用 `await` 同步等待 token_version 校验结果。DB 故障时返回 500 而非放行。

### 修改文件

- `src/middleware/auth.js`：重写为 async/await 风格

### 代码实现

```javascript
'use strict';

const jwt = require('jsonwebtoken');

let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = require('crypto').randomBytes(64).toString('hex');
  console.warn('⚠️  [Auth] JWT_SECRET 未配置，使用临时随机密钥（服务重启后所有 Token 失效）。');
  console.warn('⚠️  [Auth] 请在 .env 中配置持久化的 JWT_SECRET。');
}

/**
 * Express 中间件：校验 HttpOnly Cookie 中的 JWT
 * 验证通过后将解析结果挂到 req.user = { id, username }
 * 同时校验 token_version 确保改密码后旧 Token 失效
 */
async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) {
    return res.status(401).json({ code: 1, message: '未登录，请先登录' });
  }
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;

    // 同步校验 token_version，确保改密码后旧 Token 立即失效
    const db = require('../db/database');
    const dbVersion = await db.getTokenVersion(decoded.id);

    if (dbVersion === -1) {
      res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
      return res.status(401).json({ code: 1, message: '用户不存在，请重新登录' });
    }
    if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== dbVersion) {
      res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
      return res.status(401).json({ code: 1, message: '密码已变更，请重新登录' });
    }
    next();
  } catch (err) {
    // JWT 验证失败（过期、签名错误等）
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
      return res.status(401).json({ code: 1, message: 'Token 无效或已过期，请重新登录' });
    }
    // DB 查询等其他错误：返回 500 而非放行
    console.error('[Auth] token_version 校验失败:', err.message);
    return res.status(500).json({ code: 1, message: '认证服务暂不可用，请稍后重试' });
  }
}

module.exports = { requireAuth, getSecret: () => SECRET };
```

### 边界条件

- DB 短暂不可用时返回 500，用户需重试，不会造成安全绕过
- JWT 本身校验失败（签名错误/过期）仍返回 401 并清除 Cookie

---

## 修复项 2：Cluster 多 Worker 重复轮询

### 问题描述

`server.js:158` 中 `startIndexPolling()` 在每个 Worker 进程中都被调用。假设 4 核 CPU，会有 4 个独立的定时器同时轮询新浪/腾讯行情 API，产生 4 倍冗余的外部请求。

### 修复方案

使用 Node.js Cluster IPC 机制：只在一个 Worker（Worker #1）中执行 `startIndexPolling()`，通过 `process.send()` 将数据发送到主进程，主进程再广播给所有 Worker。

但考虑到项目复杂度和当前规模，采用更简单的方案：**仅让第一个 Worker 执行轮询**，通过环境变量 `WORKER_ID` 标识。

实际最简方案：在 `server.js` 的 cluster fork 逻辑中，给每个 Worker 设置环境变量 `WORKER_ID`，只有 `WORKER_ID === '0'` 的 Worker 启动轮询，并通过 IPC 将数据广播给其他 Worker。

**最终方案**（兼顾简洁和正确性）：将 `startIndexPolling` 移到主进程执行，主进程通过 IPC 广播给所有 Worker，Worker 收到消息后更新 `latestIndexData` 并 emit 事件。

### 修改文件

- `server.js`：主进程中启动轮询，通过 IPC 广播
- `src/services/quoteService.js`：新增 `updateIndexFromIPC(data)` 函数供 Worker 接收主进程数据

### 代码实现

**server.js 主进程部分**：
```javascript
if (cluster.isPrimary && !IS_DEV) {
  const numWorkers = os.cpus().length;
  console.log(`[Cluster] 主进程 ${process.pid} 启动，fork ${numWorkers} 个 worker`);

  for (let i = 0; i < numWorkers; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`[Cluster] worker ${worker.process.pid} 退出 (code=${code}, signal=${signal})，正在重启...`);
    cluster.fork();
  });

  // 主进程启动行情轮询，通过 IPC 广播给所有 Worker
  const { fetchMarketIndex } = require('./src/services/quoteService');
  const SSE_INTERVAL_MS = parseInt(process.env.SSE_INTERVAL_MS || '10000', 10);
  
  async function primaryPoll() {
    try {
      const result = await fetchMarketIndex();
      // 广播给所有存活的 Worker
      for (const id in cluster.workers) {
        cluster.workers[id].send({ type: 'index-update', payload: result });
      }
    } catch (err) {
      console.error('[Primary IndexPolling] 抓取失败:', err.message);
    }
  }
  primaryPoll();
  setInterval(primaryPoll, SSE_INTERVAL_MS);

  return;
}
```

**Worker 中接收 IPC 消息**（server.js Worker 部分，在 app.listen 之后）：
```javascript
// Worker 接收主进程的行情广播
if (!IS_DEV) {
  const { updateIndexFromIPC, startIndexPolling } = require('./src/services/quoteService');
  process.on('message', (msg) => {
    if (msg && msg.type === 'index-update') {
      updateIndexFromIPC(msg.payload);
    }
  });
} else {
  // 开发模式：单进程，直接本地轮询
  startIndexPolling(SSE_INTERVAL_MS);
}
```

**quoteService.js 新增导出**：
```javascript
function updateIndexFromIPC(result) {
  latestIndexData = result;
  indexEmitter.emit('index-update', result);
}

module.exports = {
  // ... existing exports ...
  updateIndexFromIPC,
};
```

### 边界条件

- 开发模式（单进程）保持原有逻辑不变
- 主进程 Worker 崩溃重启后自动接收后续 IPC 消息
- 主进程 `fetchMarketIndex` 仍复用缓存和 failover 机制

---

## 修复项 3：轮询定时器使用 setTimeout 链式调用

### 问题描述

`quoteService.js:364` 使用 `setInterval(poll, intervalMs)`，如果某次 `poll()` 执行时间超过 `intervalMs`，会导致请求重叠。

### 修复方案

改为 `setTimeout` 链式调用，确保上一次完成后再等待 intervalMs 执行下一次。

### 修改文件

- `src/services/quoteService.js`：`startIndexPolling` 函数

### 代码实现

```javascript
function startIndexPolling(intervalMs = 10000) {
  async function poll() {
    try {
      const result = await fetchMarketIndex();
      latestIndexData = result;
      indexEmitter.emit('index-update', result);
    } catch (err) {
      console.error('[IndexPolling] 抓取失败:', err.message);
    }
    setTimeout(poll, intervalMs); // 链式调用，避免重叠
  }
  poll(); // 启动时立即执行
}
```

---

## 修复项 4：uncaughtException 后触发优雅关机

### 问题描述

`server.js:177` 中 `uncaughtException` 仅打印日志但进程继续运行，此时进程状态不可预测。

### 修复方案

捕获后记录错误并触发优雅关机。`unhandledRejection` 保持警告（Node.js 未来版本会自动退出）。

### 修改文件

- `server.js`：修改异常处理逻辑

### 代码实现

```javascript
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  gracefulShutdown('uncaughtException');
});
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
```

---

## 修复项 5：killPort 仅在开发模式执行

### 问题描述

`server.js:127-146` 中的 `killPort` 使用 `kill -9` 暴力杀进程。在 Cluster 多 Worker 模式下，每个 Worker 都可能执行此逻辑产生竞态。

### 修复方案

仅在开发模式（单进程）时执行 `killPort`。Docker 环境已有跳过逻辑。

### 修改文件

- `server.js`：调整 killPort 调用条件

### 代码实现

```javascript
// 仅开发模式执行端口释放（生产环境由主进程管理）
if (IS_DEV && !process.env.DOCKER_ENV) {
  await killPort(PORT);
}
```

---

## 文档更新

### 修改文件

- `docs/security.md`：更新 Auth 中间件说明，移除"异步校验"描述，改为"同步 await 校验"
- `docs/concurrency.md`：
  - 更新第二层进程模型部分，说明 IPC 广播机制
  - 更新"已知边界"部分，标记轮询重复问题已解决
  - 更新优雅关机部分，补充 uncaughtException 处理
- `docs/nodejs-high-concurrency.md`：
  - 更新"本项目可优化项"表格，标记已完成的项
  - 更新覆盖度一览

### 更新内容要点

1. `security.md` 第 44 行：将"异步查库比对"改为"await 同步查库比对"，将"DB 查询失败时放行"改为"DB 查询失败时返回 500"
2. `concurrency.md`：新增 IPC 广播机制说明，更新架构图
3. `nodejs-high-concurrency.md`：标记"轮询定时器重叠"、"uncaughtException 后继续运行"、"killPort 在每个 Worker 执行"为已解决
