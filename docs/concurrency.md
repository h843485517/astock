# 并发处理设计文档

> 本文档聚焦**并发与性能**机制。认证、限流的安全防护细节（bcrypt、JWT、输入校验等）详见 [security.md](./security.md)。

---

## 目录

1. [整体架构](#1-整体架构)
2. [第一层：Cluster 多进程隔离](#2-第一层cluster-多进程隔离)
3. [第二层：进程内 async 并发模型](#3-第二层进程内-async-并发模型)
4. [第三层：In-Flight 请求合并（防缓存穿透）](#4-第三层in-flight-请求合并防缓存穿透)
5. [第四层：SSE 连接数限流](#5-第四层sse-连接数限流)
6. [第五层：API 全局限流](#6-第五层api-全局限流)
7. [第六层：数据库并发安全](#7-第六层数据库并发安全)
8. [第七层：SSE 推送与事件总线](#8-第七层sse-推送与事件总线)
9. [共享可变状态清单](#9-共享可变状态清单)
10. [已知边界与改进建议](#10-已知边界与改进建议)

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

---

## 2. 第一层：Cluster 多进程隔离

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

> ⚠️ **注意**：Worker 间**不共享**内存缓存（`cache Map`）和 `sourceHealth` 计数器，各 Worker 独立维护自己的缓存状态。在多核场景下，同一个行情 key 最多可能在所有 Worker 上各发一次外部请求（由 In-Flight 机制在单 Worker 内合并，见第 4 层）。

---

## 3. 第二层：进程内 async 并发模型

**Node.js 事件循环保证**：在同一个 Worker 进程内，所有 JavaScript 代码运行在**单线程**上。任何 `async` 函数的同步代码段（两个 `await` 之间的执行）**不会被其他回调打断**。

这意味着：

```js
// 以下操作是"原子"的，不会出现线程级的 Data Race
sseClientCount++;        // 读-改-写，安全
sourceHealth.sina++;     // 读-改-写，安全
cache.set(key, value);   // Map 写入，安全
```

**但"原子"不等于"无逻辑问题"**：`await` 挂起期间，其他请求的同步代码可以执行，因此在 `check → await → write` 这样的模式下，仍然存在"TOCTOU（Time-of-Check to Time-of-Use）"逻辑问题，需要在应用层处理（见第 4 层）。

---

## 4. 第三层：In-Flight 请求合并（防缓存穿透）

**文件**：`src/services/quoteService.js`

### 问题：缓存穿透（Cache Stampede）

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

### 实现代码（`fetchStockQuote`）

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

### 覆盖范围

| 函数 | In-Flight Key 格式 | 外部接口 |
|------|--------------------|---------|
| `fetchStockQuote` | `stock:sh000001,sh600519,...`（codes 排序后拼接） | 新浪财经 / 腾讯财经 |
| `fetchFundQuote` | `fund:000001` | 天天基金（东方财富） |

### 降级链路

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

---

## 5. 第四层：SSE 连接数限流

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

**心跳机制**：每个 SSE 连接每 `SSE_HEARTBEAT_MS`（最大 30s）发送一次 `: ping` 注释帧，防止 Nginx / 负载均衡因空闲超时断开长连接。

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

---

## 6. 第五层：API 全局限流

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

## 7. 第六层：数据库并发安全

**文件**：`src/db/database.js`

> SQL 注入防护、字段白名单、越权防护等**安全**方面详见 [security.md § 数据层](./security.md#数据层dbdatabasejs)。本节聚焦连接池排队、写操作原子性与优雅关机。

### 连接池

```js
const pool = mysql.createPool({
  waitForConnections: true,
  connectionLimit: parseInt(process.env.MYSQL_CONN_LIMIT || '10'),
  queueLimit: 0,   // 无限排队，不丢弃请求
});
```

- 每个 Worker 持有一个连接池，最多 10 个并发连接（可通过 `MYSQL_CONN_LIMIT` 调整）
- `waitForConnections: true` 保证池满时请求排队而非报错
- 所有 `pool.execute()` 调用使用**预编译语句**，防止 SQL 注入

### 写操作并发安全

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

### 优雅关机

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

## 8. 第七层：SSE 推送与事件总线

**文件**：`src/services/quoteService.js`、`src/routes/quote.js`

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

持仓 SSE（`/api/positions/stream`）每个连接独立定时器拉取，因为数据是**用户私有**的，无法共享广播。

---

## 9. 共享可变状态清单

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

## 10. 已知边界与改进建议

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
