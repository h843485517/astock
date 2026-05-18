# Node.js 高并发处理措施总览

> 本文档梳理 Node.js 应用处理高并发的常见措施，并标注本项目（A股收益追踪器）的采纳情况与代码位置。
> 并发机制的实现细节详见 [concurrency.md](./concurrency.md)，安全防护详见 [security.md](./security.md)。

---

## 目录

1. [多进程 / 多线程扩展](#1-多进程--多线程扩展)
2. [异步 I/O 与事件循环](#2-异步-io-与事件循环)
3. [连接池与复用](#3-连接池与复用)
4. [缓存](#4-缓存)
5. [限流与保护](#5-限流与保护)
6. [推送优化（SSE / WebSocket）](#6-推送优化sse--websocket)
7. [降级与容错](#7-降级与容错)
8. [分布式扩展（单机之外）](#8-分布式扩展单机之外)
9. [本项目可优化项](#9-本项目可优化项)

---

## 1. 多进程 / 多线程扩展

Node.js 主进程是单线程的，单个进程只能利用一个 CPU 核心。高并发场景下需要横向扩展到多核。

### 1.1 Cluster 多进程

通过 `cluster` 模块 fork 多个 Worker 进程，每个 Worker 拥有独立的 V8 堆和事件循环，OS 层面通过共享 TCP socket 实现负载均衡。

```
主进程（不处理 HTTP）
  ├── Worker 1（独立 V8、独立事件循环、独立内存）
  ├── Worker 2
  └── Worker N（N = CPU 核心数）
```

核心特性：
- **进程隔离**：任一 Worker OOM / 崩溃不影响其他 Worker
- **自动重启**：Worker 退出后主进程立即 fork 新 Worker
- **零端口冲突**：Node.js Cluster 底层只做一次 `bind`，Worker 通过 IPC 获取 socket fd

> **本项目**：`server.js` 第 12-24 行，生产环境按 `os.cpus().length` fork Worker，开发模式单进程运行。

### 1.2 Worker Threads

将 CPU 密集型任务（加解密、图片处理、大量计算）卸载到工作线程，避免阻塞主事件循环。与 Cluster 的区别在于线程间可共享内存（`SharedArrayBuffer`），但编程复杂度更高。

> **本项目**：未使用。当前无 CPU 密集场景，所有操作均为 I/O 密集（HTTP 请求、DB 查询），async/await 足以应对。

### 1.3 进程管理器

PM2、systemd 等工具提供进程守护、日志聚合、零停机重启、监控面板等能力，生产环境推荐使用。

> **本项目**：使用 Cluster 自带的 `cluster.on('exit')` 实现自动重启，未引入 PM2。

---

## 2. 异步 I/O 与事件循环

Node.js 的核心竞争力：单线程 + 非阻塞 I/O + 事件循环，能在一个进程内处理数千并发连接。

### 2.1 全链路 async/await

所有 I/O 操作（数据库查询、外部 HTTP 请求、文件读写）必须使用异步 API。一个同步阻塞调用就能卡住整个事件循环，让所有并发请求排队等待。

```js
// ✅ 异步 — 事件循环可继续处理其他请求
const [rows] = await pool.execute('SELECT ...');

// ❌ 同步 — 阻塞事件循环，所有请求排队
const data = fs.readFileSync('/path/to/file');
```

> **本项目**：全部路由处理函数和数据库操作均为 async，无同步阻塞调用。

### 2.2 避免事件循环饥饿

长时间的同步计算（如遍历百万级数组）会占住事件循环，导致其他请求"饿死"。解决方案：
- `setImmediate()` 拆分循环，让出事件循环
- 将计算卸载到 Worker Thread

> **本项目**：无长循环计算场景，不涉及此问题。

---

## 3. 连接池与复用

### 3.1 数据库连接池

每次请求新建数据库连接代价高昂（TCP 握手 + 认证 + 参数协商 ≈ 几十毫秒）。连接池预建 N 条长连接，请求到来时取一条空闲连接使用，用完归还而非销毁。

```
请求到来 → 池中有空闲连接 → 直接复用（~0ms）
请求到来 → 池满无空闲     → 排队等待（waitForConnections: true）
```

> **本项目**：`src/db/database.js`，`mysql2.createPool`，每 Worker `connectionLimit = 10`，`queueLimit = 0`（无限排队）。

### 3.2 HTTP Keep-Alive Agent

访问外部 API 时，复用 TCP 连接避免每次请求都做三次握手。对高频调用的上游接口（如行情数据源）效果明显。

```js
const http = require('http');
const agent = new http.Agent({ keepAlive: true, maxSockets: 10 });
axios.get(url, { httpAgent: agent });
```

> **本项目**：未使用。axios 默认每次请求新建连接，可作为优化项。

### 3.3 Redis 连接池

当引入 Redis 做共享缓存/会话/限流时，同样需要连接池。`ioredis` 默认维护单连接，高并发下可配置连接池。

> **本项目**：未引入 Redis。

---

## 4. 缓存

缓存是高并发系统中收益最高的优化手段，核心思路是用空间换时间，减少重复 I/O。

### 4.1 进程内内存缓存（L1）

`Map` 或 LRU Cache 存储热点数据，命中时零 I/O、零网络开销。缺点是每个 Worker 独立维护，不跨进程共享。

```js
const cache = new Map();  // key → { data, timestamp }

function getCached(key, ttl) {
  const entry = cache.get(key);
  if (!entry || Date.now() - entry.timestamp > ttl) return null;
  return entry.data;
}
```

> **本项目**：`src/services/quoteService.js`，股票行情 TTL 60s，大盘指数 TTL 10s。

### 4.2 分布式缓存（L2）

Redis / Memcached，跨 Worker、跨机器共享。适合会话存储、行情缓存、限流计数等需要全局一致性的场景。

> **本项目**：未引入。多 Worker 场景下各自独立缓存，同一 key 最多在 N 个 Worker 上各发一次外部请求。

### 4.3 请求合并（Singleflight / In-Flight 去重）

缓存 TTL 到期的瞬间，N 个并发请求同时 cache miss。若不做合并，会产生 N 次重复的外部 I/O（"缓存穿透 / Cache Stampede"）。解决方案是用一个 `Map<key, Promise>` 记录"正在进行的请求"，后续请求等待同一个 Promise。

```
请求1 → cache miss → inFlight 无 → 发起 HTTP → 注册 Promise
请求2 → cache miss → inFlight 有 → 等待同一 Promise ──┐
请求3 → cache miss → inFlight 有 → 等待同一 Promise ──┤ 共享 1 次结果
                                                        ↓
HTTP 完成 → promise.finally(() => inFlight.delete(key))  ← 清理
```

> **本项目**：`src/services/quoteService.js`，`fetchStockQuote` 和 `fetchFundQuote` 均实现了 In-Flight 合并。

### 4.4 HTTP 缓存头

通过 `Cache-Control`、`ETag`、`Last-Modified` 让浏览器和 CDN 缓存响应，减少到达服务器的请求数。

> **本项目**：SSE 路由设置 `Cache-Control: no-cache`（实时数据不可缓存），静态文件依赖 `express.static` 默认行为。

---

## 5. 限流与保护

防止恶意请求或突发流量压垮服务。

### 5.1 API 速率限制（Rate Limiting）

按 IP 或用户 ID 限制单位时间内的请求次数。常用中间件：`express-rate-limit`。

> **本项目**：`server.js` 第 73-80 行，所有 `/api/*` 路由 15 分钟内最多 300 次请求。默认使用内存存储，多 Worker 各自独立计数。

### 5.2 连接数上限

长连接（SSE / WebSocket）会持续占用服务端资源。需设置最大连接数，超出返回 `503`。

> **本项目**：`sseClientCount`（大盘 SSE，上限 100/Worker）、`positionSseCount`（持仓 SSE，上限 100/Worker）。

### 5.3 请求体大小限制

防止超大 payload 耗尽内存。

> **本项目**：`server.js` 第 84-86 行，`express.json({ limit: '100kb' })`。

### 5.4 超时控制

外部请求必须设置 timeout，避免上游不响应时无限挂起，占用连接池和事件循环资源。

> **本项目**：所有 axios 请求 `timeout: 5000`（5 秒）。

### 5.5 熔断 / 降级优先级

记录外部依赖的连续失败次数，超过阈值后自动降低该依赖的优先级或直接跳过，避免持续向不可用的上游发请求。

> **本项目**：`sourceHealth` 计数器，新浪连续失败 3 次后优先切换腾讯。

---

## 6. 推送优化（SSE / WebSocket）

实时推送场景下，服务端维护大量长连接，需要专门的优化措施。

### 6.1 发布订阅 + 一写多读

公共数据（如大盘指数）由**单一后台定时器**拉取，通过 EventEmitter 广播给所有 SSE 连接。N 个客户端只产生 1 次外部 I/O。

```
后台轮询（唯一写入源）
  └── fetchMarketIndex() → indexEmitter.emit('index-update', payload)
                                    │
                    ┌────────────────┼────────────────┐
                    ▼                ▼                ▼
                 SSE 客户端1    SSE 客户端2    SSE 客户端N
```

安全性保证：
- **无撕裂读**：单线程赋值 + emit 在同一同步代码段完成
- **emit 同步执行**：所有 listener 在同一 tick 收到相同引用
- **不可变约定**：emit 后不再修改 payload 对象

> **本项目**：`src/services/quoteService.js` 的 `indexEmitter` + `startIndexPolling`，`src/routes/quote.js` 的 SSE 订阅。详见 [concurrency.md § 第五层：实时推送](./concurrency.md#6-第五层实时推送事件总线--一写多读--心跳)。

### 6.2 心跳保活

Nginx、云 LB、浏览器等中间层会断开空闲超时的长连接。定期发送心跳帧维持连接存活。

```js
const heartbeat = setInterval(() => sseWrite(': ping\n\n'), SSE_HEARTBEAT_MS);
```

> **本项目**：SSE 心跳间隔 `min(SSE_INTERVAL_MS * 2.5, 30000)`，使用 SSE 注释帧 `: ping`。

### 6.3 绕过压缩中间件

`compression` 中间件会缓冲响应数据以提高压缩率，但这会破坏 SSE 的实时性——数据被缓冲后无法逐帧推送。

> **本项目**：`server.js` 第 64-70 行，所有 SSE 路径跳过 gzip 压缩。

### 6.4 背压控制

当客户端网络慢时，`res.write()` 的数据堆积在 Node.js 内核写缓冲区中，可能撑爆服务端内存。应检查 `res.write()` 返回值，返回 `false` 时等待 `drain` 事件或跳过本次推送。

> **本项目**：未实现。当前直接调用 `res.write()` 未检查返回值。

---

## 7. 降级与容错

高并发下外部依赖不可靠，需要多层兜底确保服务可用。

### 7.1 多数据源 Failover

主源失败时自动切换到备用源，对调用方透明。

```
新浪财经（主源）
  ├── 成功 → 返回
  └── 失败 → 腾讯财经（备用源）
               ├── 成功 → 返回
               └── 失败 → 降级到过期缓存
```

> **本项目**：`fetchStockQuote` 中新浪 → 腾讯双源 failover，全球指数失败不阻断 A 股数据。

### 7.2 过期缓存兜底（Stale Cache）

所有上游均失败时，返回 TTL 已过期但仍有参考价值的旧缓存数据，标记 `stale: true`，优于直接报错。

> **本项目**：`getStaleCached()` 返回过期数据，前端可据 `stale` 标记提示用户。

### 7.3 部分失败容忍（Promise.allSettled）

批量并行请求时，使用 `Promise.allSettled` 而非 `Promise.all`，单个子任务失败不影响其他结果。

> **本项目**：基金行情批量获取（`positions.js`、`chat.js`），单只基金查询失败不影响其他基金。

### 7.4 优雅关机（Graceful Shutdown）

收到退出信号后有序关闭：停止接受新请求 → 等待进行中的请求完成 → 排空数据库连接池 → 退出进程。

```
SIGTERM / SIGINT
  → server.close()      // 停止接受新连接
  → 等待 in-flight 请求完成
  → pool.end()          // 排空 MySQL 连接池
  → process.exit(0)
  → 10s 超时强制退出兜底
```

> **本项目**：`server.js` 第 163-174 行。

---

## 8. 分布式扩展（单机之外）

当单机无法承载流量时，需要引入分布式架构。以下措施本项目当前未涉及，列出供后续演进参考。

### 8.1 反向代理（Nginx）

Nginx 在 Node.js 前面承担：
- **TLS 卸载**：SSL 握手由 Nginx 处理，Node.js 只处理明文 HTTP
- **静态文件服务**：Nginx 直接返回静态资源，不经过 Node.js
- **连接数限制**：`limit_conn` 模块限制单 IP 并发连接
- **负载均衡**：`upstream` 分发到多个 Node.js 实例

### 8.2 Redis 共享层

引入 Redis 后可统一解决多个跨 Worker/跨实例问题：
- **共享限流计数**：`rate-limit-redis`，精确的全局限流
- **共享缓存**：行情数据 L2 缓存，减少重复外部请求
- **共享 SSE 计数**：`INCR` / `DECR` 原子操作统一管理连接数
- **会话存储**：JWT 之外如需服务端 session

### 8.3 消息队列（削峰填谷）

高峰期请求入队（RabbitMQ / Redis Stream / Kafka），由消费者异步处理。适用于写入密集或非实时性要求的场景（如快照写入、通知推送）。

### 8.4 数据库读写分离

主库负责写操作，从库负责读操作，分散数据库压力。`mysql2` 支持通过 `createPoolCluster` 配置主从。

### 8.5 CDN

静态资源和低变化频率的 API 响应放到 CDN 边缘节点，用户就近获取，减少回源。

---

## 9. 本项目可优化项

以下为当前实现中已识别的可改进点，按投入产出比排序：

| 优化项 | 现状 | 改进方案 | 成本 |
|--------|------|---------|------|
| ~~轮询定时器重叠~~ | ✅ 已改为链式 `setTimeout` | — | — |
| ~~`uncaughtException` 后继续运行~~ | ✅ 已改为触发优雅关机 | — | — |
| ~~`killPort` 在每个 Worker 执行~~ | ✅ 已改为仅开发模式执行 | — | — |
| ~~多 Worker 重复轮询行情 API~~ | ✅ 主进程统一轮询，IPC 广播给 Worker | — | — |
| ~~数据采集依赖客户端登录~~ | ✅ 已添加服务端每日定时快照（`snapshotService.js`） | — | — |
| 外部 HTTP 无 Keep-Alive | 每次请求新建 TCP 连接 | 创建共享 `http.Agent({ keepAlive: true })` | 低 |
| MySQL 连接池无心跳 | 空闲连接可能被 MySQL 断开 | 启用 `enableKeepAlive: true` | 低 |
| 缓存无大小限制 | `cache Map` 无上限无淘汰 | 引入 LRU 或设置 `maxSize` | 低 |
| 同用户多标签页重复拉取 | 持仓 SSE 每连接独立定时器 | 按 `userId` 聚合发布订阅 | 中 |
| SSE 无背压控制 | `res.write()` 不检查返回值 | 检查返回值，慢客户端跳过推送 | 中 |
| 优雅关机不关闭 SSE | 长连接阻止 server.close 完成 | 维护连接集合，关机时主动 `res.end()` | 中 |
| 限流计数不跨 Worker | 实际阈值 = 配置 × Worker 数 | 引入 `rate-limit-redis` | 中 |
| 基金行情聚合逻辑重复 | `positions.js` 与 `chat.js` 相同代码 | 提取为 `quoteService` 公共函数 | 低 |

---

## 附录：措施覆盖度一览

```
✅ 已实现    ⚠️ 部分实现    ❌ 未实现（当前不需要或可作为优化项）

多进程扩展
  ✅ Cluster 多进程
  ❌ Worker Threads（无 CPU 密集场景）
  ⚠️ 进程管理（自带重启，未用 PM2）

异步 I/O
  ✅ 全链路 async/await
  ✅ 无同步阻塞调用

连接池与复用
  ✅ MySQL 连接池
  ❌ HTTP Keep-Alive Agent
  ❌ Redis 连接池

缓存
  ✅ 进程内内存缓存
  ✅ In-Flight 请求合并
  ❌ 分布式缓存（Redis）

限流与保护
  ✅ API 速率限制
  ✅ SSE 连接数上限
  ✅ 请求体大小限制
  ✅ 外部请求超时
  ✅ 数据源熔断降级

推送优化
  ✅ 发布订阅一写多读
  ✅ 心跳保活
  ✅ 绕过压缩
  ❌ 背压控制

降级与容错
  ✅ 双数据源 Failover
  ✅ 过期缓存兜底
  ✅ Promise.allSettled 部分失败容忍
  ✅ 优雅关机

定时任务
  ✅ 服务端每日定时快照（snapshotService.js，工作日 15:10 北京时间）
```
