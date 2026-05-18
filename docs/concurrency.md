# 并发处理设计文档

> 本文档聚焦**并发与性能**机制。认证、限流的安全防护细节（bcrypt、JWT、输入校验等）详见 [security.md](./security.md)。
> 各措施的通用原理与横向对比详见 [nodejs-high-concurrency.md](./nodejs-high-concurrency.md)。

---

## 目录

1. [整体架构](#1-整体架构)
2. [第一层：进程模型（Cluster + 事件循环）](#2-第一层进程模型cluster--事件循环)
3. [第二层：接入控制（限流 + 连接数上限）](#3-第二层接入控制限流--连接数上限)
4. [第三层：数据获取（缓存 + 去重 + 容错 + 并行）](#4-第三层数据获取缓存--去重--容错--并行)
5. [第四层：数据持久化（连接池 + 原子写入 + 优雅关机）](#5-第四层数据持久化连接池--原子写入--优雅关机)
6. [第五层：实时推送（事件总线 + 一写多读 + 心跳）](#6-第五层实时推送事件总线--一写多读--心跳)
7. [第六层：定时快照任务（服务端自动采集）](#7-第六层定时快照任务服务端自动采集)
8. [共享可变状态清单](#8-共享可变状态清单)
9. [已知边界与改进建议](#9-已知边界与改进建议)

---

## 1. 整体架构

```
┌─────────────────────────────────────────────────────┐
│                 Linux / macOS 宿主机                  │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │             Primary Process (主进程)           │   │
│  │   server.js: cluster.isPrimary → fork × N    │   │
│  │   仅负责派生 Worker，不处理任何 HTTP 请求       │   │
│  └───────┬──────────────────────┬───────────────┘   │
│          │  fork                │  fork             │
│  ┌───────▼──────┐      ┌────────▼─────┐             │
│  │   Worker 1   │      │   Worker 2   │  ...        │
│  │ 独立 V8 堆   │      │ 独立 V8 堆   │             │
│  │ 独立事件循环 │      │ 独立事件循环 │             │
│  │ 连接池 ×10   │      │ 连接池 ×10   │             │
│  └──────┬───────┘      └──────┬───────┘             │
│         │                    │                      │
│         └──────────┬─────────┘                      │
│                    │  共享 TCP 端口（由 OS 分发）      │
│                    ▼                                 │
│             MySQL / 外部行情 API                      │
└─────────────────────────────────────────────────────┘
```

**核心原则**：每个 Worker 是独立 OS 进程，拥有完全隔离的内存空间。所谓"共享状态"只存在于**同一 Worker 进程内部**，跨 Worker 不共享任何 JS 变量。

### 请求生命周期与五层对应

```
客户端请求
  → ① 进程模型：OS 将 TCP 连接分发给某个 Worker（Cluster）
  → ② 接入控制：限流检查（Rate Limit）/ SSE 连接数检查
  → ③ 数据获取：读缓存 → In-Flight 去重 → 多源 Failover → 并行拉取
  → ④ 数据持久化：连接池复用 → 原子写入 → 优雅关机排空
  → ⑤ 实时推送：事件总线广播 → SSE 帧写入 → 心跳保活
```

---

## 2. 第一层：进程模型（Cluster + 事件循环）

> 请求到达服务器的第一站：OS 选择哪个 Worker 处理？Worker 内部如何高效处理并发？

### 2.1 Cluster 多进程隔离

**文件**：`server.js`

```js
// 生产环境按 CPU 核心数 fork Worker
if (cluster.isPrimary && !IS_DEV) {
  const numWorkers = os.cpus().length;
  for (let i = 0; i < numWorkers; i++) cluster.fork();

  // Worker 崩溃后自动重启，保障服务持续可用
  cluster.on('exit', (worker) => {
    cluster.fork();
  });
}
```

| 特性 | 说明 |
|------|------|
| **进程隔离** | 每个 Worker 独立 V8 堆，任一 Worker OOM/崩溃不影响其他 Worker |
| **负载均衡** | OS 层面 Round-Robin 分发入站 TCP 连接 |
| **自动重启** | `cluster.on('exit')` 监听 Worker 退出并立即重新派生 |
| **开发模式** | `NODE_ENV=development` 时单进程运行，便于调试 |

#### 共享 TCP 端口的实现原理

图中"共享 TCP 端口（由 OS 分发）"在代码中体现为以下两个关键点：

**① 主进程 `return`，不执行任何 HTTP 逻辑**（`server.js` 第 23 行）

```js
if (cluster.isPrimary && !IS_DEV) {
  for (let i = 0; i < numWorkers; i++) cluster.fork();
  return; // 主进程到此结束，不会执行下方的 app.listen()
}

// 以下代码只有 Worker 进程才会执行
const express = require('express');
// ...
```

**② 每个 Worker 都调用 `app.listen(PORT)`**（`server.js` 第 146 行）

```js
server = app.listen(PORT, () => {
  console.log(`✅ A股收益追踪器已启动：http://localhost:${PORT}`);
  // 生产模式：行情由主进程 IPC 广播，Worker 只接收消息
  // 开发模式：单进程直接本地轮询
});
```

N 个 Worker 进程各自执行了这行，全部"监听"同一个端口（默认 3000）。

**为什么不报端口冲突？**

正常情况下多个进程绑定同一端口会报 `EADDRINUSE`，但 Node.js Cluster 在底层做了透明处理：

```
Worker 调用 app.listen(3000)
  ↓
Node.js 检测到当前是 cluster worker
  ↓
不执行真正的 bind(3000)，而是通过 IPC 向主进程发消息："我想监听 3000"
  ↓
主进程把自己已 bind 的 socket fd 通过 IPC 传回给 Worker
  ↓
Worker 拿到 fd，调用 accept() 等待入站连接
```

所以代码里看起来每个 Worker 都在 `listen(3000)`，实际上**只有主进程做了一次真正的 `bind`**，所有 Worker 共享同一个 socket 的引用。OS 在多个同时等待 `accept()` 的 Worker 中选一个处理每条入站连接，这就是负载均衡的底层机制。

#### 行情轮询的进程归属（IPC 广播）

大盘行情轮询（`startIndexPolling`）在生产 Cluster 模式下移至**主进程**执行，通过 IPC 广播给所有 Worker，避免 N 个 Worker 各自独立调用外部行情 API：

```
主进程
  └── primaryPoll()  每 SSE_INTERVAL_MS 拉取一次行情
        └── cluster.workers[id].send({ type: 'index-update', payload })
                   │
     ┌─────────────┼─────────────┐
     ▼             ▼             ▼
  Worker 1      Worker 2      Worker N
  process.on('message')  接收行情数据
  updateIndexFromIPC(payload)
  indexEmitter.emit('index-update', payload)  广播给本 Worker 的 SSE 客户端
```

开发模式（单进程）保持原有逻辑：`startIndexPolling` 在应用进程内直接运行。

> ⚠️ **注意**：Worker 间**不共享**内存缓存（`cache Map`）和 `sourceHealth` 计数器，各 Worker 独立维护自己的缓存状态。在多核场景下，同一个行情 key 最多可能在所有 Worker 上各发一次外部请求（由 In-Flight 机制在单 Worker 内合并，见第三层）。

### 2.2 进程内 async 并发模型

**Node.js 事件循环保证**：在同一个 Worker 进程内，所有 JavaScript 代码运行在**单线程**上。任何 `async` 函数的同步代码段（两个 `await` 之间的执行）**不会被其他回调打断**。

这意味着：

```js
// 以下操作是"原子"的，不会出现线程级的 Data Race
sseClientCount++;        // 读-改-写，安全
sourceHealth.sina++;     // 读-改-写，安全
cache.set(key, value);   // Map 写入，安全
```

**但"原子"不等于"无逻辑问题"**：`await` 挂起期间，其他请求的同步代码可以执行，因此在 `check → await → write` 这样的模式下，仍然存在"TOCTOU（Time-of-Check to Time-of-Use）"逻辑问题，需要在应用层处理（见第三层 In-Flight 合并）。

---

## 3. 第二层：接入控制（限流 + 连接数上限）

> 请求进入 Worker 后的第一道防线：判断是否允许继续处理。超出限额直接快速拒绝，保护下游资源。

### 3.1 SSE 连接数限流

**文件**：`src/routes/quote.js`、`src/routes/positions.js`

每个 Worker 进程独立维护当前 SSE 连接数，超过上限直接返回 `503`：

```js
// quote.js — 大盘指数推送
let sseClientCount = 0;
const MAX_SSE_CLIENTS = 100;          // 可通过环境变量配置

router.get('/market-index/stream', (req, res) => {
  if (sseClientCount >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ code: 1, message: 'SSE 连接数已满，请稍后重试' });
  }
  sseClientCount++;

  req.on('close', () => {
    sseClientCount--;   // 客户端断开时归还计数
  });
});
```

```js
// positions.js — 持仓推送
let positionSseCount = 0;
const MAX_SSE_CLIENTS = parseInt(process.env.MAX_SSE_CLIENTS || '100', 10);
```

| 路由 | 计数变量 | 上限 |
|------|----------|------|
| `GET /api/market-index/stream` | `sseClientCount` | 100（硬编码） |
| `GET /api/positions/stream` | `positionSseCount` | `MAX_SSE_CLIENTS`（env 可配） |
| `GET /api/chat/stream` | 无独立计数 | 受全局限流约束 |

**SSE 绕过压缩**：`server.js` 中通过 `compress.filter` 对所有 SSE 路径跳过 gzip 压缩，防止 `compression` 中间件缓冲数据导致实时推送延迟。

```js
const SSE_PATHS = ['/api/market-index/stream', '/api/positions/stream', '/api/chat/stream'];
app.use(compress({
  filter: (req) => {
    if (SSE_PATHS.some(p => req.path.startsWith(p))) return false;
    return compress.filter(req, res);
  },
}));
```

### 3.2 API 全局限流

**文件**：`server.js`

> 限流的**安全防护**视角（防暴力攻击、登录限流、注册限流）详见 [security.md](./security.md)。本节仅关注多 Worker 场景下的并发边界。

使用 `express-rate-limit` 对所有 `/api/*` 路由进行速率限制：

```js
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,                                     // 15 分钟窗口
  max:      parseInt(process.env.RATE_LIMIT_API_MAX || '300'),   // 最多 300 次
  standardHeaders: true,
  handler: (req, res) =>
    res.status(429).json({ code: 1, message: '请求过于频繁，请稍后再试' }),
});
app.use('/api', apiLimiter);
```

| 配置项 | 默认值 | 环境变量 |
|--------|--------|----------|
| 时间窗口 | 15 分钟 | — |
| 最大请求数 | 300 次 | `RATE_LIMIT_API_MAX` |
| 超限响应 | `429 Too Many Requests` | — |

> ⚠️ `express-rate-limit` 默认使用**内存存储**，计数状态仅在单个 Worker 内有效。多 Worker 场景下，每个 Worker 独立计数，实际可承受的请求上限约为 `300 × Worker数量`。如需跨 Worker 精确限流，需引入 Redis 存储（如 `rate-limit-redis`）。

---

## 4. 第三层：数据获取（缓存 + 去重 + 容错 + 并行）

> 通过接入控制后，开始获取业务数据。本层优化目标：尽可能减少外部 I/O 次数、降低延迟、保障可用性。

### 4.1 In-Flight 请求合并（防缓存穿透）

**文件**：`src/services/quoteService.js`

#### 问题：缓存穿透（Cache Stampede）

```
缓存 TTL 到期的瞬间，N 个并发请求同时到达：

❌ 修复前：
  请求1 → getCached() = null → 发 HTTP 到新浪 ─┐
  请求2 → getCached() = null → 发 HTTP 到新浪  │  N 次重复外部请求
  请求3 → getCached() = null → 发 HTTP 到新浪 ─┘

✅ 修复后（In-Flight 合并）：
  请求1 → getCached() = null → inFlight 无 → 创建 Promise → 发 1 次 HTTP ─┐
  请求2 → getCached() = null → inFlight 有 → 等待同一 Promise ─────────────┤ 共享 1 次结果
  请求3 → getCached() = null → inFlight 有 → 等待同一 Promise ─────────────┘
  请求结束 → promise.finally() → inFlight.delete(key)   ← 防内存泄漏
```

#### 实现代码（`fetchStockQuote`）

```js
// 模块级：key -> Promise（进行中的请求）
const inFlight = new Map();

async function fetchStockQuote(codes, ttl = CACHE_TTL) {
  const cacheKey = `stock:${[...codes].sort().join(',')}`;

  // 1. 命中有效缓存，直接返回
  const hit = getCached(cacheKey, ttl);
  if (hit) return { ...hit, cached: true };

  // 2. 已有同 key 的请求正在进行，复用同一 Promise
  if (inFlight.has(cacheKey)) {
    return inFlight.get(cacheKey);
  }

  // 3. 发起新请求，注册到 inFlight
  const promise = (async () => { /* 实际 HTTP 请求 + 写缓存 */ })();

  inFlight.set(cacheKey, promise);
  promise.finally(() => inFlight.delete(cacheKey)); // 请求完成后清理

  return promise;
}
```

#### 覆盖范围

| 函数 | In-Flight Key 格式 | 外部接口 |
|------|--------------------|---------|
| `fetchStockQuote` | `stock:sh000001,sh600519,...`（codes 排序后拼接） | 新浪财经 / 腾讯财经 |
| `fetchFundQuote` | `fund:000001` | 天天基金（东方财富） |

### 4.2 多源 Failover 降级链路

```
fetchStockQuote(codes)
  ├─ 缓存命中（TTL 内）          → 直接返回，cached: true
  ├─ In-Flight 命中              → 等待同一 Promise
  ├─ 新浪财经拉取成功            → 写缓存，返回
  ├─ 新浪失败 → 腾讯财经拉取成功 → 写缓存，返回
  └─ 两个源均失败                → 返回 stale 过期缓存（stale: true）
                                  若无缓存，抛出异常 502
```

`sourceHealth` 计数器记录各数据源连续失败次数，超过阈值（默认 3 次）后自动降低该源的优先级，切换为备用源优先。

### 4.3 基金行情并行化（Promise.allSettled）

**文件**：`src/routes/positions.js`、`src/routes/chat.js`、`client/src/composables/usePositionStream.js`

基金行情通过天天基金 API 逐只查询（每只一个 HTTP 请求），原实现为串行循环，N 只基金需要串行 N 次外部 HTTP 调用，延迟随持仓数量线性增长。

#### 优化方案

```js
// ❌ 优化前：串行，延迟 = N × 单次延迟
for (const code of fundCodes) {
  const d = await fetchFundQuote(code); // 逐只等待
  quotes[code] = buildFundQuote(d);
}

// ✅ 优化后：并行，延迟 ≈ max(单次延迟)
const settled = await Promise.allSettled(
  fundCodes.map(async (code) => {
    const d   = await fetchFundQuote(code);
    const pct = d.gszzl || 0;
    return {
      code,
      data: { name: d.name, current: +(d.dwjz*(1+pct/100)).toFixed(4), ... },
    };
  })
);
for (const r of settled) {
  if (r.status === 'fulfilled') quotes[r.value.code] = r.value.data;
}
```

使用 `Promise.allSettled` 而非 `Promise.all` 的原因：单只基金查询失败不影响其他基金的结果，通过过滤 `status === 'fulfilled'` 的结果，可安全地忽略部分失败。

#### 覆盖范围

| 文件 | 场景 |
|------|------|
| `src/routes/positions.js → buildPositionPayload()` | 后端 SSE 推送时基金行情并行获取 |
| `src/routes/chat.js → POST /stream` | AI 聊天上下文构建时基金行情并行获取 |
| `client/src/composables/usePositionStream.js → manualRefresh()` | 前端手动刷新时基金行情并行获取 |

---

## 5. 第四层：数据持久化（连接池 + 原子写入 + 优雅关机）

**文件**：`src/db/database.js`

> SQL 注入防护、字段白名单、越权防护等**安全**方面详见 [security.md § 数据层](./security.md#数据层dbdatabasejs)。本节聚焦连接池排队、写操作原子性与优雅关机。

### 5.1 连接池

#### 为什么需要连接池？

建立一条数据库连接的代价很高，每次请求都新建连接会重复承担以下开销：

```
客户端发起请求
  → TCP 三次握手
  → MySQL 身份认证（用户名/密码）
  → 协商字符集、时区等参数
  → 连接就绪
  ≈ 几十毫秒
```

连接池通过**预建连接 + 复用 + 排队**解决这个问题，用维持若干长连接的空间开销，换取省去每次请求连接建立的时间开销。

#### 工作方式

```
应用启动时预先建立 N 条连接放入"池"中：

  ┌──────────────────────────────────────┐
  │              连接池                   │
  │  [连接1: 空闲]  [连接2: 空闲]         │
  │  [连接3: 占用]  [连接4: 空闲]  ...    │  connectionLimit = 10
  └──────────────────────────────────────┘

请求1  来了 → 取一条空闲连接 → 执行 SQL → 归还（不销毁）
请求2  来了 → 取另一条空闲连接 → 执行 SQL → 归还
请求11 来了 → 池满无空闲连接 → 排队等待（waitForConnections: true）
```

#### 项目配置

```js
const pool = mysql.createPool({
  waitForConnections: true,
  connectionLimit: parseInt(process.env.MYSQL_CONN_LIMIT || '10'),
  queueLimit: 0,   // 无限排队，不丢弃请求
});
```

| 参数 | 默认值 | 含义 |
|------|--------|------|
| `connectionLimit` | `10` | 该 Worker 最多同时持有 10 条 MySQL 连接 |
| `waitForConnections` | `true` | 池满时请求排队等待，而不是直接抛错 |
| `queueLimit` | `0` | 排队无上限，不会因等待队列满而丢弃请求 |

> 每个 Worker 独立持有一个连接池。4 核机器有 4 个 Worker，MySQL 实际最多承受 `10 × 4 = 40` 条并发连接，规划 `MYSQL_CONN_LIMIT` 时需考虑 Worker 数量。

- 所有 `pool.execute()` 调用使用**预编译语句**，防止 SQL 注入

### 5.2 写操作并发安全

| 场景 | 机制 | 代码位置 |
|------|------|----------|
| 新增持仓 | `INSERT INTO positions` — MySQL 行锁保障 | `createPosition()` |
| 更新持仓 | `UPDATE ... WHERE id=? AND user_id=?` — 原子更新，防越权 | `updatePosition()` |
| 删除持仓 | `DELETE ... WHERE id=? AND user_id=?` — 原子删除，防越权 | `deletePosition()` |
| 今日快照写入 | `INSERT ... ON DUPLICATE KEY UPDATE` — upsert 原子操作 | `upsertDailySnapshot()` |
| 历史快照写入 | `INSERT IGNORE` — 幂等写入，重复调用安全 | `upsertDailySnapshot()` |
| 字段更新白名单 | `ALLOWED_UPDATE_FIELDS` 过滤，防原型链污染 | `updatePosition()` |

```js
// 唯一约束防止快照重复
UNIQUE KEY uk_user_date (user_id, snap_date)

// 今日：可覆盖更新
INSERT ... ON DUPLICATE KEY UPDATE total_asset = VALUES(total_asset), ...

// 历史：幂等，已有则跳过
INSERT IGNORE INTO daily_snapshots ...
```

### 5.3 优雅关机

```js
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

async function gracefulShutdown(signal) {
  server.close();        // 停止接受新请求
  await pool.end();      // 等待所有 DB 连接完成后关闭
  process.exit(0);
}
```

关机时先停止 HTTP 监听，再等待连接池中所有进行中的查询完成，避免强杀导致数据不一致。

---

## 6. 第五层：实时推送（事件总线 + 一写多读 + 心跳）

**文件**：`src/services/quoteService.js`、`src/routes/quote.js`

> 数据获取和持久化完成后，通过 SSE 将实时数据推送给客户端。本层优化目标：N 个连接共享 1 次外部 I/O，保持长连接存活。

### 6.1 事件总线与一写多读

大盘指数的 SSE 推送基于 Node.js 内置 `EventEmitter` 实现**一写多读**的发布订阅，避免每个 SSE 连接各自定时拉取外部 API：

```
后台轮询（单一定时器）
  └── fetchMarketIndex() ────→ indexEmitter.emit('index-update', payload)
                                       │
                       ┌───────────────┼───────────────┐
                       ▼               ▼               ▼
                    SSE 客户端1    SSE 客户端2    SSE 客户端N
                    sseWrite()     sseWrite()     sseWrite()
```

```js
// 单一后台轮询
function startIndexPolling(intervalMs = 10000) {
  setInterval(async () => {
    const result = await fetchMarketIndex();
    latestIndexData = result;                       // 供新连接立即获取
    indexEmitter.emit('index-update', result);      // 广播给所有订阅者
  }, intervalMs);
}

// 每个 SSE 连接订阅事件
indexEmitter.on('index-update', onUpdate);
req.on('close', () => indexEmitter.off('index-update', onUpdate)); // 断开时取消订阅
```

| 设计点 | 说明 |
|--------|------|
| `setMaxListeners(200)` | 避免 Node.js 内存泄漏警告（默认上限 10） |
| `latestIndexData` 缓存 | 新 SSE 连接建立时立即推送最新数据，无需等待下一个轮询周期 |
| `indexEmitter.off()` | 客户端断开时解除订阅，防止向已关闭的 Response 写数据 |

**心跳机制**：每个 SSE 连接每 `SSE_HEARTBEAT_MS`（最大 30s）发送一次 `: ping` 注释帧，防止 Nginx / 负载均衡因空闲超时断开长连接。

### 6.2 一写多读的安全性分析

"一写多读"指的是：**只有一个写入源**（后台轮询定时器）修改共享数据，**多个读取方**（SSE 连接）消费数据。该模式在本项目中涉及两个共享变量：

| 变量 | 写入方 | 读取方 | 写频率 |
|------|--------|--------|--------|
| `latestIndexData` | `startIndexPolling` 定时器回调 | 新 SSE 连接的 `getLatestIndexData()` | 每 10s 一次 |
| `indexEmitter.emit()` 的 payload | `startIndexPolling` 定时器回调 | 所有已订阅 SSE 连接的 `onUpdate` 回调 | 每 10s 一次 |

#### 为什么单写多读在 Node.js 中是安全的？

```
事件循环第 N 轮
  ├── poll() 执行 →  latestIndexData = result   (写入)
  │                   indexEmitter.emit(...)      (同步触发所有 listener)
  │                     ├── onUpdate(client1) → sseWrite()   ← 同步执行
  │                     ├── onUpdate(client2) → sseWrite()   ← 同步执行
  │                     └── onUpdate(clientN) → sseWrite()   ← 同步执行
  │
  │   以上全部在同一个宏任务中完成，不可能被打断
  │
事件循环第 N+1 轮
  ├── 新 SSE 连接到达 → getLatestIndexData()  (读取已写好的值)
  ...
```

关键保证：

1. **无撕裂读（No Torn Read）**：JavaScript 单线程意味着 `latestIndexData = result` 的赋值和后续的 `emit` 在同一个同步代码段完成。任何读取方只能在这段代码执行**之前或之后**读到值，不存在"读到写了一半的对象"的可能。

2. **EventEmitter.emit() 是同步调用**：`emit('index-update', result)` 会在当前调用栈中**依次同步执行**所有注册的 listener。这意味着所有 SSE 客户端在**同一个事件循环 tick** 内收到完全相同的 `result` 引用，不存在"部分客户端收到旧数据、部分收到新数据"的时序问题。

3. **引用传递的不可变性约定**：`result` 对象在 `emit` 后不再被修改（下一次 poll 会生成新的 `result` 对象），因此所有 listener 共享同一个引用是安全的。若 poll 后续复用并修改了同一个对象，则会出现"读到半更新状态"的逻辑 Bug。

#### 对比：为什么多写多读不安全？

```js
// ❌ 假设多个来源同时写入 latestIndexData
async function pollSourceA() { latestIndexData = await fetchA(); }  // 写入源1
async function pollSourceB() { latestIndexData = await fetchB(); }  // 写入源2

// 时序：
// tick1: pollSourceA await 挂起
// tick2: pollSourceB await 挂起
// tick3: fetchB 先返回 → latestIndexData = B的结果
// tick4: fetchA 后返回 → latestIndexData = A的结果（覆盖了 B）
// → 后写入的不一定是最新数据，产生"更新丢失"
```

本项目中所有写入点都归口到 `startIndexPolling` 的**唯一定时器**，从设计上杜绝了多写竞争。

#### 新连接的"冷启动"问题与解决

```js
// quote.js 第 93-96 行
const latest = getLatestIndexData();
if (latest) {
  sseWrite(`data: ${JSON.stringify(latest)}\n\n`);  // 立即推送
}
indexEmitter.on('index-update', onUpdate);           // 然后订阅后续更新
```

如果没有 `latestIndexData` 缓存，新 SSE 客户端需要等到下一次轮询（最多 10 秒）才能收到第一帧数据，造成用户感知的"白屏延迟"。通过在写入 `emit` 的同时更新 `latestIndexData`，新连接可以**立即获取最近一次轮询结果**。

> 注意：`getLatestIndexData()` 和 `indexEmitter.on()` 之间存在极小的时序间隙——如果恰好在这两行之间触发了一次 `emit`，该次更新会被新连接错过。但由于两行代码都是同步的（中间没有 `await`），它们在同一个事件循环 tick 内执行，**不可能被 emit 打断**，因此这个间隙在 Node.js 中不存在。

### 6.3 持仓 SSE 为何不能使用一写多读？

持仓 SSE（`/api/positions/stream`）每个连接独立定时器拉取，因为数据是**用户私有**的，无法共享广播：

```
大盘指数（公共数据）──── 一写多读 ✅
  1 个轮询 → N 个 SSE 连接，数据完全相同

持仓行情（私有数据）──── 一写一读 ✅ / 一写多读 ⚠️ 需按 userId 分组
  用户A 的持仓 ≠ 用户B 的持仓
  每个连接需要查询各自用户的 positions + quotes
```

如果同一用户在多个标签页打开持仓页面，当前实现会为每个 SSE 连接创建独立定时器。可进一步优化为按 `userId` 聚合的发布订阅模式，使同用户的多个连接共享同一个定时拉取结果。

---

## 7. 第六层：定时快照任务（服务端自动采集）

**文件**：`src/services/snapshotService.js`

> 解决"用户未登录期间数据空白"问题。前五层均为请求驱动，本层为时间驱动，每个工作日收盘后自动为所有有持仓用户生成快照。

### 7.1 触发机制

每个工作日 **15:10 北京时间**（收盘后 5 分钟），使用链式 `setTimeout` 调度，确保上次执行完成后再等待下一次：

```js
function startDailySnapshotScheduler() {
  async function schedule() {
    const ms = msUntilNextSnapshot(); // 计算到下一个工作日 15:10 的 ms 数
    setTimeout(async () => {
      await runDailySnapshot();
      schedule(); // 链式调用，避免定时器重叠
    }, ms);
  }
  schedule();
}
```

### 7.2 进程归属

| 运行模式 | 定时器位置 | 原因 |
|----------|-----------|------|
| 生产（Cluster 多 Worker） | **主进程**（`cluster.isPrimary`） | 避免 N 个 Worker 各自独立触发，产生重复写入 |
| 开发（单进程） | Worker 进程（唯一进程） | 无 Cluster，直接在应用进程内运行 |

### 7.3 数据流

```
每日 15:10 北京时间（主进程/单进程）
  → isWeekday() 检查（周六/日跳过）
  → db.getAllActiveUsers()  查 positions 表所有 DISTINCT user_id
  → Promise.allSettled(userIds.map(generateSnapshotForUser))
      ↳ db.getAllPositions(userId)
      ↳ fetchStockQuote(stockCodes)          ← 复用行情缓存
      ↳ Promise.allSettled(fundCodes.map(fetchFundQuote))
      ↳ computeSnapshot(positions, quotes)   ← 计算总资产/盈亏
      ↳ db.upsertDailySnapshot(userId, snap) ← INSERT IGNORE（历史日期幂等）
  → 日志：成功/跳过/失败用户数
  → schedule() 安排下一次
```

### 7.4 幂等性保障

- `upsertDailySnapshot` 对**历史日期**使用 `INSERT IGNORE`：若用户当天已登录并由客户端保存了快照，服务端任务不会覆盖它
- 对**今日**使用 `ON DUPLICATE KEY UPDATE`：服务端 15:10 的快照即为当日最终值

### 7.5 容错处理

| 场景 | 处理方式 |
|------|----------|
| 单用户行情获取失败 | 按成本价估算该持仓，仍保存快照 |
| 单用户无持仓 | 跳过，不写入 |
| 单用户 DB 写入失败 | 记录错误，不影响其他用户（`Promise.allSettled`） |
| 整体任务失败（DB 不可用等） | 记录错误，等待下一个工作日重试 |
| 周末/节假日 | 周末通过 `isWeekday()` 跳过；节假日当前不处理（行情返回前一交易日数据） |

---

## 8. 共享可变状态清单

以下是同一 Worker 进程内所有共享可变状态，及其并发安全分析：

| 变量 | 所在文件 | 类型 | 并发风险 | 结论 |
|------|----------|------|----------|------|
| `cache` | `quoteService.js` | `Map<string, {data, timestamp}>` | 缓存穿透：TTL 到期时多请求同时 miss | ✅ 已通过 `inFlight` 解决 |
| `inFlight` | `quoteService.js` | `Map<string, Promise>` | 无——注册/删除均在同步代码段完成 | ✅ 安全 |
| `latestIndexData` | `quoteService.js` | `object \| null` | 轮询写 + SSE 读，无写写竞争 | ✅ 安全（单写多读） |
| `sourceHealth` | `quoteService.js` | `{sina: number, tencent: number}` | 多并发失败请求同时自增，计数略有误差 | 🟡 可接受（仅影响切换时机，不影响数据正确性） |
| `sseClientCount` | `routes/quote.js` | `number` | `++`/`--` 原子，但上限判断与自增之间有隙 | ✅ 单线程原子，安全 |
| `positionSseCount` | `routes/positions.js` | `number` | 同上 | ✅ 安全 |

---

## 9. 已知边界与改进建议

### 边界 1：限流计数器不跨 Worker 共享

**现状**：`express-rate-limit` 使用内存存储，N 个 Worker 各自独立计数。  
**影响**：实际限流阈值约为配置值的 N 倍。  
**改进**：引入 Redis 共享存储。

```bash
pnpm add rate-limit-redis ioredis
```

```js
const RedisStore = require('rate-limit-redis');
const redis = new Redis(process.env.REDIS_URL);

const apiLimiter = rateLimit({
  store: new RedisStore({ sendCommand: (...args) => redis.call(...args) }),
  // ...
});
```

---

### 边界 2：SSE 连接数计数不跨 Worker 共享

**现状**：`sseClientCount` 和 `positionSseCount` 是 Worker 级变量，总连接数为所有 Worker 之和，但每个 Worker 只看到自己的份额。  
**影响**：单台服务器上的实际 SSE 连接上限约为 `MAX_SSE_CLIENTS × Worker数量`。  
**改进**：同样可通过 Redis 原子计数（`INCR` / `DECR`）统一管理。

---

### 边界 3：`sourceHealth` 多请求并发计数误差

**现状**：缓存穿透期间（In-Flight 生效前的极短窗口），多个失败请求可能同时执行 `sourceHealth[source]++`，导致计数快速叠加。  
**影响**：数据源切换时机略有偏差，不影响数据正确性。  
**改进**（可选，低优先级）：使用 `Math.min(sourceHealth[source] + 1, MAX_VALUE)` 避免计数无限增长。

---

### 边界 4：行情缓存不跨 Worker 共享

**现状**：每个 Worker 维护独立的内存 `cache Map`，同一 key 在不同 Worker 上各自独立缓存。  
**影响**：不影响正确性；高并发下外部 API 调用次数约为单 Worker 的 N 倍（已被各 Worker 的 In-Flight 各自合并）。  
**改进**：引入 Redis 作为共享二级缓存，进一步减少外部 API 调用。

---

### 边界 5：Chat SSE 无独立连接数限制

**现状**：`/api/chat/stream` 没有独立的 `chatSseCount` 计数，仅靠全局 API 限流约束。  
**影响**：极端情况下 AI 流式推送连接过多，可能拖慢 Worker。  
**改进**：参考 `market-index/stream` 和 `positions/stream` 添加独立的连接数上限。

---

## 附录：环境变量速查

| 变量 | 默认值 | 影响范围 |
|------|--------|----------|
| `QUOTE_CACHE_TTL_MS` | `60000`（60s） | 股票/基金行情缓存 TTL |
| `SSE_INTERVAL_MS` | `10000`（10s） | SSE 推送间隔 & 大盘轮询间隔 |
| `MAX_SSE_CLIENTS` | `100` | 持仓 SSE 最大连接数 |
| `MYSQL_CONN_LIMIT` | `10` | 每个 Worker 的 MySQL 连接池上限 |
| `RATE_LIMIT_API_MAX` | `300` | 15 分钟内最大 API 请求次数（单 Worker） |
| `REQUEST_BODY_LIMIT` | `100kb` | 请求体大小上限 |
