# 服务端安全校验说明

> 本文档聚焦**安全防护**机制。高并发、缓存穿透、SSE 连接数限制的完整并发设计详见 [concurrency.md](./concurrency.md)。

---

## 全局层（server.js）

| 机制 | 详情 |
|------|------|
| **Helmet 安全头** | 配置严格的 CSP，限制脚本/样式/字体/图片/接口来源，防 XSS 与点击劫持 |
| **全局 API 限流** | `/api` 所有接口：15 分钟内同 IP 最多 300 次，超出返回 HTTP 429；可通过 `RATE_LIMIT_API_MAX` 环境变量调整。⚠️ 限流计数器基于内存，**多 Worker 场景下每个 Worker 独立计数**，实际阈值约为配置值 × Worker 数量，如需跨进程精确限流须引入 Redis Store（见 [concurrency.md § 边界1](./concurrency.md#边界-1限流计数器不跨-worker-共享)） |
| **请求体大小限制** | JSON / URLEncoded 请求体上限 100 KB（可通过 `REQUEST_BODY_LIMIT` 调整），超出返回 HTTP 413，防超大请求攻击 |
| **统一错误兜底** | 全局错误中间件捕获未处理异常，仅向客户端返回通用描述，避免堆栈信息泄露 |
| **Health Check 端点** | `GET /api/health` 不需要认证，返回 `{status:'ok', uptime}`，供 Docker healthcheck 和监控系统使用，不暴露任何敏感数据 |

---

## 认证层 · Token 与 Cookie（middleware/auth.js）

| 机制 | 详情 |
|------|------|
| **JWT + HttpOnly Cookie** | Token 存于 HttpOnly Cookie（键名 `token`），前端 JS 无法读取，防 XSS 窃取 |
| **SameSite=Strict** | Cookie 不随跨站请求携带，防 CSRF 攻击 |
| **Secure Cookie 动态判断** | 注册/登录时同时检查 `req.protocol === 'https'` 与 `NODE_ENV=production`，两者均满足才设置 `Secure`，避免本地开发因 Secure 标志导致 Cookie 无法写入 |
| **Cookie 有效期** | Cookie `maxAge` 默认 604800000 ms（7 天），与 JWT 过期时间对齐；可通过 `COOKIE_MAX_AGE_MS` 独立调整 |
| **JWT 过期与清除** | Token 默认 7 天有效（`JWT_EXPIRES_IN`）；验证失败时服务端主动清除客户端 Cookie |
| **JWT_SECRET 兜底警告** | 未配置 `JWT_SECRET` 时使用随机临时密钥并打印安全警告，重启后所有 Token 失效 |
| **VIP 状态实时查库** | `/api/auth/me` 不解析 Token 中的 `is_vip` 字段，而是每次实时查询数据库，确保管理员升/降级后立即生效，不受 Token 有效期影响 |

---

## 认证层 · 账户接口（routes/auth.js）

| 机制 | 详情 |
|------|------|
| **登录专用限流** | 同 IP 5 分钟内最多 10 次失败登录，成功登录不计入次数；可通过 `RATE_LIMIT_LOGIN_MAX` 调整 |
| **注册限流** | 同 IP 1 小时内最多 5 次注册，防批量注册；可通过 `RATE_LIMIT_REGISTER_MAX` 调整 |
| **bcrypt 哈希** | 密码使用 bcrypt 哈希（默认 12 轮，可通过 `BCRYPT_ROUNDS` 调整）存储，绝不存明文 |
| **时序攻击防护** | 登录时无论用户是否存在都执行 `bcrypt.compare`（用户不存在时使用 dummy hash），防止通过响应时间枚举用户名 |
| **密码强度校验** | ≥8 位，必须同时包含大写字母、小写字母、数字 |
| **用户名格式校验** | 3~20 位，仅允许字母/数字/下划线，正则白名单校验 |
| **修改密码** | `PUT /api/auth/password` 需先校验原密码（`bcrypt.compare`），新密码同样经过强度校验后以 bcrypt 重新哈希存储 |
| **修改密码后旧 Token 失效（token_version）** | `users` 表新增 `token_version INT UNSIGNED` 字段；修改密码时执行 `token_version = token_version + 1`，并清除客户端 Cookie；`requireAuth` 中间件在 JWT 签名验证通过后异步查库比对 `decoded.tokenVersion`，版本不匹配返回 `401`，确保密码修改后所有旧 Token 立即失效 |

---

## 业务层（routes/positions.js + routes/chat.js + routes/history.js）

| 机制 | 详情 |
|------|------|
| **全路由强制登录** | `router.use(requireAuth)` 统一拦截持仓、历史快照和 AI 聊天所有接口，未登录返回 HTTP 401 |
| **越权访问防护（路由层）** | 修改/删除前先查询记录，校验 `existing.user_id !== req.user.id`，越权返回 HTTP 403 |
| **输入白名单校验** | `type`、`code`、`shares`、`cost_price`、`group_name` 均有格式、范围、长度的严格校验 |
| **Chat 消息长度限制** | 用户消息超过 500 字符时服务端截断（`MAX_MESSAGE_LEN = 500`），历史对话最多保留最近 10 轮（20 条），每条历史内容截断至 1000 字符，防止超大 Prompt 注入 |
| **Chat history 字段校验** | 解析对话历史时过滤非法 `role`（仅允许 `user` / `assistant`），丢弃 `content` 非字符串的条目，防止注入构造 system 角色消息 |
| **历史快照参数校验** | `year` 限制在 2020–2100，`month` 限制在 1–12；日期范围接口校验 `YYYY-MM-DD` 格式并确保 `start ≤ end`，防止非法参数导致全表扫描 |
| **Chat XSS 加固** | `renderText()` 对 AI 回复内容进行完整 HTML 转义（`&`、`<`、`>`、`"`、`'`），防止 AI 生成内容中含有 HTML 标签或引号时注入到页面 DOM |
| **持仓接口错误脱敏** | `positions.js` 所有 `catch` 块统一返回通用消息 `操作失败，请稍后重试`，原始错误仅通过 `console.error` 记录服务端日志，防止内部 DB 错误信息泄露给客户端 |
| **SSE 连接数限制** | 各 SSE 端点独立计数，超出上限返回 HTTP 503。各端点上限如下：`/api/positions/stream` 上限 `MAX_SSE_CLIENTS`（env 可配，默认 100）；`/api/market-index/stream` 上限硬编码 100；`/api/chat/stream` 无独立上限，受全局 API 限流约束。⚠️ 计数为 Worker 级，多 Worker 场景下实际总连接数为各 Worker 之和（见 [concurrency.md § 边界2](./concurrency.md#边界-2sse-连接数计数不跨-worker-共享)） |
| **AI 双模式路由** | 根据用户 `is_vip` 字段自动路由：`0` → 免费云端 API，`1` → 本地 Ollama，服务端判定不可绕过 |

---

## 数据层（db/database.js）

| 机制 | 详情 |
|------|------|
| **预编译语句（Prepared Statement）** | 所有 SQL 均通过 `pool.execute('...?', [params])` 参数化执行，彻底防 SQL 注入 |
| **字段更新白名单** | `ALLOWED_UPDATE_FIELDS` 冻结对象限制可更新字段集合，防原型链污染攻击 |
| **SQL 层二次越权防护** | `UPDATE` 和 `DELETE` 的 WHERE 条件中强制追加 `AND user_id = ?`，即使绕过路由层校验仍有兜底保障 |

---

## 安全相关环境变量速查

| 变量名 | 默认值 | 说明 |
|--------|--------|------|
| `JWT_SECRET` | 随机临时串 | JWT 签名密钥，**生产必须配置** |
| `JWT_EXPIRES_IN` | `7d` | Token 有效期 |
| `BCRYPT_ROUNDS` | `12` | bcrypt 哈希轮数 |
| `RATE_LIMIT_API_MAX` | `300` | 全局 API 15 分钟限流阈值（单 Worker） |
| `RATE_LIMIT_LOGIN_MAX` | `10` | 登录 5 分钟限流阈值（单 Worker） |
| `RATE_LIMIT_REGISTER_MAX` | `5` | 注册 1 小时限流阈值（单 Worker） |
| `REQUEST_BODY_LIMIT` | `100kb` | 请求体大小上限 |
| `MAX_SSE_CLIENTS` | `100` | 持仓 SSE 最大并发连接数（单 Worker，`/api/market-index/stream` 为硬编码 100） |
| `COOKIE_MAX_AGE_MS` | `604800000`（7天） | Cookie 有效期（ms），默认与 JWT 对齐 |
| `NODE_ENV` | — | 设为 `production` 时启用 Secure Cookie |
| `HTTPS_ENABLED` | — | 设为 `true` 时启用完整 CSP 及 HSTS（仅 HTTPS 部署时开启） |