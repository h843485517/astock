# 服务端安全校验说明

> 版本：v1.0 · 更新时间：2026-03-13

---

## 全局层（server.js）

| 机制 | 详情 |
|------|------|
| **Helmet 安全头** | 配置严格的 CSP，限制脚本/样式/字体/图片/接口来源，防 XSS 与点击劫持 |
| **全局 API 限流** | `/api` 所有接口：15 分钟内同 IP 最多 300 次，超出返回 HTTP 429；可通过 `RATE_LIMIT_API_MAX` 环境变量调整 |
| **请求体大小限制** | JSON / URLEncoded 请求体上限 100 KB（可通过 `REQUEST_BODY_LIMIT` 调整），超出返回 HTTP 413，防超大请求攻击 |
| **统一错误兜底** | 全局错误中间件捕获未处理异常，仅向客户端返回通用描述，避免堆栈信息泄露 |

---

## 认证层（middleware/auth.js + routes/auth.js）

| 机制 | 详情 |
|------|------|
| **JWT + HttpOnly Cookie** | Token 存于 HttpOnly Cookie（键名 `token`），前端 JS 无法读取，防 XSS 窃取 |
| **SameSite=Strict** | Cookie 不随跨站请求携带，防 CSRF 攻击 |
| **Secure（生产环境）** | `NODE_ENV=production` 时 Cookie 仅通过 HTTPS 传输 |
| **登录专用限流** | 同 IP 5 分钟内最多 10 次失败登录，成功登录不计入次数；可通过 `RATE_LIMIT_LOGIN_MAX` 调整 |
| **注册限流** | 同 IP 1 小时内最多 5 次注册，防批量注册；可通过 `RATE_LIMIT_REGISTER_MAX` 调整 |
| **bcrypt 哈希** | 密码使用 bcrypt 哈希（默认 12 轮，可通过 `BCRYPT_ROUNDS` 调整）存储，绝不存明文 |
| **时序攻击防护** | 登录时无论用户是否存在都执行 `bcrypt.compare`（用户不存在时使用 dummy hash），防止通过响应时间枚举用户名 |
| **密码强度校验** | ≥8 位，必须同时包含大写字母、小写字母、数字 |
| **用户名格式校验** | 3~20 位，仅允许字母/数字/下划线，正则白名单校验 |
| **JWT 过期与清除** | Token 默认 7 天有效（`JWT_EXPIRES_IN`）；验证失败时服务端主动清除客户端 Cookie |
| **JWT_SECRET 兜底警告** | 未配置 `JWT_SECRET` 时使用随机临时密钥并打印安全警告，重启后所有 Token 失效 |

---

## 业务层（routes/positions.js + routes/chat.js）

| 机制 | 详情 |
|------|------|
| **全路由强制登录** | `router.use(requireAuth)` 统一拦截持仓和 AI 聊天所有接口，未登录返回 HTTP 401 |
| **越权访问防护（路由层）** | 修改/删除前先查询记录，校验 `existing.user_id !== req.user.id`，越权返回 HTTP 403 |
| **输入白名单校验** | `type`、`code`、`shares`、`cost_price`、`group_name` 均有格式、范围、长度的严格校验 |
| **SSE 连接数限制** | 持仓推送 SSE 同时最多 100 个连接（`MAX_SSE_CLIENTS`），超出返回 HTTP 503 |
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
| `RATE_LIMIT_API_MAX` | `300` | 全局 API 15 分钟限流阈值 |
| `RATE_LIMIT_LOGIN_MAX` | `10` | 登录 5 分钟限流阈值 |
| `RATE_LIMIT_REGISTER_MAX` | `5` | 注册 1 小时限流阈值 |
| `REQUEST_BODY_LIMIT` | `100kb` | 请求体大小上限 |
| `MAX_SSE_CLIENTS` | `100` | SSE 最大并发连接数 |
| `NODE_ENV` | — | 设为 `production` 时启用 Secure Cookie |