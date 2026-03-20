# A 股实时收益追踪器 — 全栈优化分析报告

> 部署环境：MySQL + Docker 部署在同一台阿里云 ECS 上，HTTP 直连（无域名/HTTPS）

---

## 约束前提（用户明确说明）

以下事项属于已知约束或有意设计，**不列入优化范围**：

| 约束 | 说明 |
|------|------|
| HTTP-only 部署 | 暂无域名和 SSL 证书，HTTP 环境下 CSP（含 HSTS、upgrade-insecure-requests）和 Cookie Secure 已有意关闭以保证资源正常加载 |
| `.env` 不入库 | `.env` 仅存在于 ECS 服务器上，不会提交到代码库 |
| MySQL 非 root 用户 | 已使用专用账户（如 `astock_user`），非 root 连接 |
| Docker 容器配置不改动 | Dockerfile 当前配置满足需求，不做修改（如 USER 指令、HEALTHCHECK 等） |
| Docker 网桥 IP 硬编码 | `172.17.0.1` 为有意设计，不做变更 |
| MySQL 备份 | 暂不需要备份策略 |

---

## 一、安全类（Security）

### 1.1 [严重] `server.js` 命令注入风险
- **文件**: `server.js:122-135`
- **问题**: `killPort()` 函数使用 `child_process.exec()` 拼接 `PORT` 环境变量执行 shell 命令。若 `PORT` 被设置为 `3000; rm -rf /` 等恶意值，会导致任意命令执行。
- **建议**: 改用 `execFile` + 参数数组，或在使用前校验 `PORT` 为纯数字。
- **影响文件**:
  - `server.js` — `killPort()` 函数
- **实现要点**:
  ```js
  // 在 killPort 调用前校验
  const port = parseInt(process.env.PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('Invalid PORT');
  }
  ```

### 1.2 [中] 前端 Chat 页面 XSS 风险
- **文件**: `client/src/pages/Chat.vue:76, 239-244`
- **问题**: 使用 `v-html` 渲染 AI 回复内容，手写的 `renderText()` 仅转义 `<>&` 未转义引号（`"`, `'`）。AI 模型输出不可控，若未来添加属性级渲染场景可导致 XSS。
- **建议**: 强化 `renderText()` 转义，补充引号转义；或引入 DOMPurify 做安全清洗。
- **影响文件**:
  - `client/src/pages/Chat.vue` — `renderText()` 函数
- **实现要点**:
  ```js
  function renderText(text) {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;')
      .replace(/\n/g, '<br>');
  }
  ```

### 1.3 [中] 修改密码后旧 Token 仍有效
- **文件**: `src/routes/auth.js:127-148`, `src/middleware/auth.js`, `src/db/database.js`
- **问题**: 用户修改密码后，原 JWT（7 天有效期）不会失效。若 Token 已被盗取，改密码无法阻止攻击者继续使用。
- **建议**: 在 `users` 表增加 `token_version` 字段（默认 0），签发 JWT 时写入版本号，校验时比对；改密码时自增版本号使所有旧 Token 失效。
- **影响文件**:
  - `src/db/database.js` — DDL 新增列 + 查询/更新方法
  - `src/routes/auth.js` — 登录签发时写入 token_version，改密码时自增
  - `src/middleware/auth.js` — 校验时比对 token_version

### 1.4 [低] 错误信息泄露内部细节
- **文件**: `src/routes/positions.js:72, 149, 195, 214`
- **问题**: catch 块直接返回 `err.message`，可能暴露表名、SQL 语法、文件路径等内部信息给前端用户。
- **建议**: 对外返回通用错误消息（如"操作失败，请稍后重试"），仅在 `console.error` 中记录原始错误。
- **影响文件**:
  - `src/routes/positions.js` — 所有 catch 块

---

## 二、性能类（Performance）

### 2.1 [严重] 基金行情串行请求（后端 + 前端）
- **后端文件**: `src/routes/positions.js:47-59`
- **前端文件**: `client/src/pages/Home.vue:237-243`, `client/src/pages/Positions.vue` 同位置
- **问题**: 基金行情逐只串行请求天天基金 API（每只 5s 超时），用户持有 10 只基金 = 最多 50s 才能完成一轮推送。后端 SSE 每 10s 推送一次，单次推送耗时可能超过推送间隔，导致数据延迟。前端 `manualRefresh` 也有同样问题。
- **建议**: 使用 `Promise.allSettled()` 并行请求所有基金行情。
- **影响文件**:
  - `src/routes/positions.js` — `buildPositionPayload()` 中的基金行情循环
  - `client/src/pages/Home.vue` — `manualRefresh()` 中的基金行情循环
  - `client/src/pages/Positions.vue` — `refresh()` 中的基金行情循环

### 2.2 [严重] 前端路由无懒加载
- **文件**: `client/src/router/index.js:2-7`
- **问题**: 6 个页面组件全部静态导入，所有代码打包到单一 chunk。用户访问登录页也要下载 Chat、History 等全部代码，增大首屏加载时间。
- **建议**: 使用 `() => import(...)` 实现路由级代码分割（code splitting）。
- **影响文件**:
  - `client/src/router/index.js` — 6 个 import 语句改为动态导入

### 2.3 [中] 每次路由跳转都请求 `/api/auth/me`
- **文件**: `client/src/router/index.js:26-34`
- **问题**: `router.beforeEach` 守卫对每次非公开路由跳转都发一次 `GET /api/auth/me` 验证登录态。用户在 Home -> Positions -> Chat 间切换产生冗余请求，增加延迟和服务端负载。
- **建议**: 引入内存缓存（`ref<User | null>`），首次验证成功后缓存用户信息，后续跳转直接使用缓存；收到 401 响应时清除缓存强制重新验证。
- **影响文件**:
  - `client/src/router/index.js` — beforeEach 逻辑

### 2.4 [中] 前端持仓 SSE 无重连机制
- **文件**: `client/src/pages/Home.vue:220-223`, `client/src/pages/Positions.vue:408`
- **问题**: 大盘指数 SSE（`Home.vue:142-181`）有完善的指数退避重连策略，但持仓 SSE 断开后仅设 `sseActive = false`，不自动重连。用户必须手动刷新页面才能恢复实时数据。
- **建议**: 复用大盘 SSE 的退避重连逻辑（初始 2s，指数退避至 30s 上限）。
- **影响文件**:
  - `client/src/pages/Home.vue` — 持仓 SSE 连接的 onerror 处理
  - `client/src/pages/Positions.vue` — 持仓 SSE 连接的 onerror 处理

### 2.5 [中] 前端 SSE + refresh 逻辑大量重复
- **文件**: `client/src/pages/Home.vue:201-251` vs `client/src/pages/Positions.vue:391-437`
- **问题**: Home 和 Positions 各自独立维护持仓 SSE 连接创建、数据处理、manualRefresh 函数，代码几乎完全重复（包括 stocks/funds 分离、行情合并逻辑）。DRY 违规，维护时容易改了一处忘了另一处。
- **建议**: 抽取 `usePositionStream` composable 统一管理 SSE 连接和刷新逻辑。
- **影响文件**:
  - 新建 `client/src/composables/usePositionStream.js`
  - `client/src/pages/Home.vue` — 引用 composable 替代重复代码
  - `client/src/pages/Positions.vue` — 引用 composable 替代重复代码

### 2.6 [中] 持仓 CRUD 存在多余 DB 查询
- **文件**: `src/routes/positions.js:133-146, 159-193`
- **问题**:
  - POST 创建：插入后立即 `getPositionById` 回查（第 2 次查询），可从输入 + insertId 构建返回值
  - PUT 更新：鉴权查（第 1 次）+ 执行更新（第 2 次）+ 回查返回（第 3 次），共 3 次 DB 往返
- **建议**: 减少不必要的回查。POST 可基于输入数据构造返回对象；PUT 可在更新后合并鉴权查的数据与更新字段返回。
- **影响文件**:
  - `src/routes/positions.js` — POST 和 PUT 路由处理函数

### 2.7 [低] `daily_snapshots` 表冗余索引
- **文件**: `src/db/database.js:94-95`
- **问题**: UNIQUE KEY `uk_user_date(user_id, snap_date)` 已可作为索引使用，额外的 `INDEX idx_user_date(user_id, snap_date)` 完全冗余，浪费存储和写入性能。
- **建议**: 移除冗余的 `idx_user_date` 索引。
- **影响文件**:
  - `src/db/database.js` — DDL 建表语句

### 2.8 [低] Chat SSE 用 GET 传递完整对话历史
- **文件**: `client/src/pages/Chat.vue:268-277`, `src/routes/chat.js`
- **问题**: 对话历史以 JSON 序列化后放在 URL 参数中，40 条消息（配置上限）轻松超过浏览器 URL 长度限制（2KB-8KB），导致请求静默失败。
- **建议**: 改用 `fetch()` + `ReadableStream` 实现 POST-based SSE，将对话历史放在请求体中。
- **影响文件**:
  - `client/src/pages/Chat.vue` — SSE 连接创建逻辑
  - `src/routes/chat.js` — 路由从 GET 改为 POST，解析 body

---

## 三、部署/运维类（DevOps）

### 3.1 [中] Docker Compose 无资源限制
- **文件**: `docker-compose.yml:49-72`
- **问题**: 无 CPU/内存限制。Node.js 出现内存泄露时可能耗尽 ECS 全部内存，导致同机 MySQL 被 OOM Killer 杀掉，影响数据完整性。
- **建议**: 添加 `deploy.resources.limits`（如 `memory: 1g`）。
- **影响文件**:
  - `docker-compose.yml` — app 服务配置

### 3.2 [中] 无日志管理
- **文件**: `docker-compose.yml`
- **问题**: Docker 默认 `json-file` 日志驱动无大小限制。长期运行后日志文件会持续增长，最终占满 ECS 磁盘。
- **建议**: 配置 `logging` 限制日志大小和文件数。
- **影响文件**:
  - `docker-compose.yml` — app 服务配置
- **实现要点**:
  ```yaml
  logging:
    driver: json-file
    options:
      max-size: "50m"
      max-file: "5"
  ```

### 3.3 [低] 无 Health Check
- **文件**: `docker-compose.yml`
- **问题**: Docker 无法探测应用是否存活（进程在但服务不响应的情况），`restart: unless-stopped` 只能在进程退出时重启，对服务假死无效。
- **建议**: 后端增加 `/api/health` 端点，docker-compose 增加 `healthcheck` 配置。
- **影响文件**:
  - `server.js` — 新增 health 端点
  - `docker-compose.yml` — 新增 healthcheck

---

## 四、功能/可维护性类

### 4.1 [低] 前端无全局错误边界
- **文件**: `client/src/main.js`
- **问题**: 无 `app.config.errorHandler`，组件渲染时抛出异常会导致整个应用白屏崩溃。
- **建议**: 添加全局错误处理，至少能 console.error 并给用户一个友好提示。
- **影响文件**:
  - `client/src/main.js` — 添加 app.config.errorHandler

### 4.2 [低] 死依赖 `browser-sync`
- **文件**: `package.json:33`
- **问题**: `browser-sync` 在 devDependencies 中但无任何 npm scripts 或代码引用。
- **建议**: 移除。
- **影响文件**:
  - `package.json` — devDependencies

---

## 五、文档同步

完成上述优化后，需要同步更新以下文档，使文档内容与代码实际行为一致：

### 5.1 `docs/security.md`
- 新增：token_version 机制说明（改密码后 Token 失效）
- 新增：Chat XSS 防护加强说明
- 新增：positions 路由错误信息脱敏说明
- 新增：`/api/health` 端点说明（如实现）

### 5.2 `docs/concurrency.md`
- 新增：基金行情并行化说明（`Promise.allSettled` 替代串行循环）
- 更新：持仓 SSE 架构说明（如做了广播/去重优化）

### 5.3 `docs/api.md`
- 更新：`/api/chat/stream` 从 GET 改为 POST 的请求方式、参数格式
- 新增：`/api/health` 端点说明（如实现）
- 更新：`PUT /api/auth/password` 新增 token_version 行为说明

### 5.4 `docs/deployment.md`
- 更新：docker-compose 新增 logging 和 healthcheck 配置说明
- 更新：docker-compose 新增资源限制说明

### 5.5 `docs/deployment-aliyun.md`
- 更新：docker-compose 配置变化说明（logging、healthcheck、resources）

### 5.6 `docs/environments.md`
- 更新：如有新增环境变量或配置变化，同步更新

### 5.7 `README.md`
- 更新安全说明章节：新增 token_version、XSS 加固、错误脱敏
- 更新 API 接口概览：`/api/chat/stream` 方法从 GET 改为 POST
- 新增 `/api/health` 接口（如实现）
- 已知限制/待办事项表格可移除已完成的优化项

---

## 六、优化优先级汇总

| 优先级 | 类别 | 事项 |
|--------|------|------|
| P0 | 安全 | 命令注入修复（1.1） |
| P1 | 性能 | 基金行情并行化（2.1）、路由懒加载（2.2） |
| P1 | 安全 | Chat XSS 加固（1.2）、密码修改 Token 失效（1.3） |
| P2 | 性能 | auth/me 缓存（2.3）、持仓 SSE 重连（2.4）、SSE composable 抽取（2.5）、CRUD 查询精简（2.6） |
| P2 | 性能 | Chat POST-based SSE（2.8） |
| P2 | 安全 | 错误信息脱敏（1.4） |
| P2 | 运维 | Docker 资源限制（3.1）、日志管理（3.2）、Health Check（3.3） |
| P3 | 性能 | 冗余索引移除（2.7） |
| P3 | 前端 | 全局错误边界（4.1）、移除死依赖（4.2） |
| P3 | 文档 | 同步更新全部文档（五） |
