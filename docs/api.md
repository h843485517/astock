# A股实时收益追踪器 — 接口文档

> 版本：v1.0 · 更新时间：2026-03-13  
> Base URL：`http://{host}:{PORT}/api`（默认端口 3000）

---

## 通用约定

### 响应格式

所有 JSON 接口统一返回：

```json
{ "code": 0, "data": { ... } }           // 成功
{ "code": 1, "message": "错误描述" }     // 失败
```

### 认证方式

登录成功后服务端颁发 **HttpOnly Cookie**（键名 `token`），后续请求浏览器自动携带，无需手动设置 Header。

### 限流规则

| 范围 | 默认限制 | 环境变量 |
|------|---------|---------|
| 全局 API | 15 分钟内每 IP 最多 300 次 | `RATE_LIMIT_API_MAX` |
| 登录接口 | 5 分钟内每 IP 最多 10 次（成功不计）| `RATE_LIMIT_LOGIN_MAX` |
| 注册接口 | 1 小时内每 IP 最多 5 次 | `RATE_LIMIT_REGISTER_MAX` |

触发限流时返回 HTTP `429`：
```json
{ "code": 1, "message": "请求过于频繁，请稍后再试" }
```

---

## 认证模块 `/api/auth`

### POST /api/auth/register — 注册

**请求体**
```json
{
  "username": "string",   // 3~20 位，字母/数字/下划线
  "password": "string"    // ≥8 位，含大写字母、小写字母、数字
}
```

**成功响应** `200`
```json
{ "code": 0, "data": { "username": "alice" } }
```

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 用户名/密码格式不合法（具体说明） |
| 409 | 用户名已被占用 |

---

### POST /api/auth/login — 登录

**请求体**
```json
{
  "username": "string",
  "password": "string"
}
```

**成功响应** `200`  
同时通过 `Set-Cookie` 颁发 JWT Token（HttpOnly + SameSite=Strict）。
```json
{ "code": 0, "data": { "username": "alice" } }
```

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 请填写用户名和密码 |
| 401 | 用户名或密码错误 |

---

### POST /api/auth/logout — 登出

无请求体，清除客户端 Cookie。

**成功响应** `200`
```json
{ "code": 0, "data": null }
```

---

### GET /api/auth/me — 获取当前用户信息

**需要登录**

**成功响应** `200`
```json
{ "code": 0, "data": { "id": 1, "username": "alice" } }
```

**失败响应**
| HTTP | message |
|------|---------|
| 401 | 未登录 / 未登录或登录已过期 |

---

### PUT /api/auth/password — 修改密码

**需要登录**

**请求体**
```json
{
  "oldPassword": "string",
  "newPassword": "string"   // 同注册密码强度要求
}
```

**成功响应** `200`
```json
{ "code": 0, "data": null }
```

**备注**  
修改密码成功后服务端会自动清除客户端 Token Cookie，并将 `users.token_version` 加 1，使所有旧 Token 立即失效（包括其他设备上的登录会话）。

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 请填写原密码和新密码 / 密码格式不合法 |
| 401 | 原密码错误 |
| 404 | 用户不存在 |

---

## 持仓模块 `/api/positions`

> 所有持仓接口均需登录，操作只能作用于当前用户自身数据。

### GET /api/positions — 获取所有持仓

**成功响应** `200`
```json
{
  "code": 0,
  "data": [
    {
      "id": 1,
      "user_id": 1,
      "type": "stock",           // "stock" | "fund"
      "code": "sh600519",
      "name": "贵州茅台",
      "shares": "100.0000",
      "cost_price": "1800.0000",
      "group_name": "核心仓",
      "created_at": "2025-01-01T00:00:00.000Z"
    }
  ]
}
```

---

### GET /api/positions/stream — 持仓实时 SSE 推送

**需要登录** · **响应类型：`text/event-stream`**

连接建立后立即推送一次，之后每隔 `SSE_INTERVAL_MS`（默认 10s）推送一次。

**SSE 事件格式**
```
data: {"code":0,"positions":[...],"quotes":{"sh600519":{"name":"贵州茅台","current":1930.0,"change_pct":1.5,...}}}
```

**quotes 字段说明**
| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | string | 证券名称 |
| `current` | number | 当前价 |
| `close` | number | 昨收价 |
| `change_pct` | number | 涨跌幅（%） |
| `change_amount` | number | 涨跌额 |
| `volume` | number | 成交量（手，仅股票） |

**错误响应**
| HTTP | message |
|------|---------|
| 503 | SSE 连接数已满，请稍后重试（上限由 `MAX_SSE_CLIENTS` 控制）|

---

### POST /api/positions — 新增持仓

**请求体**
```json
{
  "type": "stock",          // 必填，"stock" | "fund"
  "code": "600519",         // 必填，6 位数字，股票可带 sh/sz 前缀
  "shares": 100,            // 必填，持有份额，正数，≤100亿
  "cost_price": 1800.00,   // 必填，成本价，正数，≤1000万
  "group_name": "核心仓"   // 可选，≤30 字符
}
```

**成功响应** `200`  
返回完整持仓记录（含服务端异步回填的证券名称，可能短暂为空）。
```json
{ "code": 0, "data": { "id": 1, "type": "stock", "code": "sh600519", ... } }
```

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 参数校验失败（具体说明）|

---

### PUT /api/positions/:id — 修改持仓

**路径参数**：`id` — 持仓 ID（整数）

**请求体**（所有字段可选，至少传一个）
```json
{
  "shares": 200,
  "cost_price": 1750.00,
  "group_name": "新分组",
  "name": "自定义名称"
}
```

**成功响应** `200`
```json
{ "code": 0, "data": { "id": 1, ... } }
```

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 无效的持仓 ID / 参数校验失败 / 更新失败 |
| 403 | 无权操作该持仓 |
| 404 | 持仓不存在 |

---

### DELETE /api/positions/:id — 删除持仓

**路径参数**：`id` — 持仓 ID（整数）

**成功响应** `200`
```json
{ "code": 0, "data": { "id": 1 } }
```

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 无效的持仓 ID |
| 403 | 无权操作该持仓 |
| 404 | 持仓不存在 |

---

## 行情模块 `/api`

> 行情接口无需登录。数据来源：新浪财经（股票/指数）、天天基金（基金估值）。

### GET /api/quote — 批量获取股票行情

**Query 参数**
| 参数 | 必填 | 说明 |
|------|------|------|
| `codes` | ✅ | 逗号分隔的股票代码，如 `sh600519,sz000001`，纯6位数字自动补前缀 |

**成功响应** `200`
```json
{
  "code": 0,
  "data": {
    "sh600519": {
      "name": "贵州茅台",
      "current": 1930.00,
      "open": 1910.00,
      "high": 1940.00,
      "low": 1905.00,
      "close": 1900.00,
      "change_pct": 1.58,
      "change_amount": 30.00,
      "volume": 12345
    }
  }
}
```

若实时请求失败但有缓存，附加 `"stale": true` 字段。

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 缺少 codes 参数 / codes 参数为空 |
| 502 | 行情获取失败（无缓存可降级时）|

---

### GET /api/fund-quote — 获取基金估值

**Query 参数**
| 参数 | 必填 | 说明 |
|------|------|------|
| `code` | ✅ | 6 位纯数字基金代码，如 `000001` |

**成功响应** `200`
```json
{
  "code": 0,
  "data": {
    "code": "000001",
    "name": "华夏成长混合",
    "dwjz": 1.2345,      // 昨日净值
    "gsz": 1.2400,       // 今日估算净值
    "gszzl": 0.45,       // 估算涨跌幅（%）
    "gztime": "2025-03-13 15:00"
  }
}
```

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 基金代码格式不正确，应为 6 位数字 |
| 502 | 基金估值获取失败 |

---

### GET /api/market-index — 大盘指数（一次性 JSON）

无参数。

**成功响应** `200`  
返回 A 股 6 只指数 + 全球 3 只指数的行情数据，字段同 `/api/quote`。

```json
{
  "code": 0,
  "stale": false,
  "data": {
    "sh000001": { "name": "上证指数", "current": 3200.00, ... },
    "sz399001": { "name": "深证成指", ... },
    "sz399006": { "name": "创业板指", ... },
    "sh000016": { "name": "上证50",   ... },
    "sh000300": { "name": "沪深300",  ... },
    "sh000905": { "name": "中证500",  ... },
    "gb_dji":   { "name": "道琼斯",   ..., "isGlobal": true },
    "gb_ixic":  { "name": "纳斯达克", ..., "isGlobal": true },
    "gb_inx":   { "name": "标普500",  ..., "isGlobal": true }
  }
}
```

---

### GET /api/market-index/stream — 大盘指数 SSE 推送

**响应类型：`text/event-stream`**

连接后立即推送最新数据，之后每隔 `SSE_INTERVAL_MS`（默认 10s）推送。

**SSE 事件格式**
```
data: {"data":{"sh000001":{...},...},"stale":false}
```

**错误响应**
| HTTP | message |
|------|---------|
| 503 | SSE 连接数已满，请稍后重试 |

---

## AI 顾问模块 `/api/chat`

> 需登录；依赖 Ollama 本地服务（`OLLAMA_BASE_URL` / `OLLAMA_MODEL`，推荐使用 `qwen2.5:3b`）。

### POST /api/chat/stream — AI 流式问答

**需要登录** · **响应类型：`text/event-stream`**

> ⚠️ 原 `GET /api/chat/stream`（使用 Query 参数）已更改为 **POST**，参数通过 JSON 请求体传递，解决了历史记录超长时 URL 越界的问题。

**请求体**
```json
{
  "message": "帮我分析一下当前持仓",
  "codes":   "sh600519,000001",
  "history": [
    { "role": "user",      "content": "上次问的问题" },
    { "role": "assistant", "content": "上次的回复" }
  ]
}
```

| 字段 | 必填 | 说明 |
|------|------|------|
| `message` | ✅ | 用户问题，超过 500 字自动截断 |
| `codes` | 可选 | 逗号分隔的标的代码，附带近 30 日历史 K 线送入上下文 |
| `history` | 可选 | 多轮对话历史（最近 10 轮 = 20 条），每条 `content` 超 1000 字截断 |

**SSE 事件格式**
```
data: {"token":"今日"}
data: {"token":"贵州茅台"}
...
data: [DONE]
```

**错误事件（仍通过 SSE 推送）**
```json
{ "error": "OLLAMA_NOT_AVAILABLE" }                     // Ollama 未启动
{ "error": "STREAM_ERROR", "message": "..." }           // 流式传输中断
{ "error": "SERVER_ERROR", "message": "..." }           // 服务端异常
```

**失败响应（非 SSE）**
| HTTP | message |
|------|---------|
| 400 | 请输入问题 |
| 401 | 未登录 |

---

### GET /api/chat/history-quote — 获取标的历史 K 线

**需要登录**

**Query 参数**
| 参数 | 必填 | 说明 |
|------|------|------|
| `code` | ✅ | 股票代码（纯6位数字或带 sh/sz 前缀）|

**成功响应** `200`  
返回近 30 日日线数据（按日期升序）。
```json
{
  "code": 0,
  "data": [
    { "day": "2025-02-10", "open": "1890.00", "high": "1920.00", "low": "1880.00", "close": "1910.00", "volume": "12345" },
    ...
  ]
}
```

**失败响应**
| HTTP | message |
|------|---------|
| 400 | 缺少 code 参数 |
| 502 | 历史行情获取失败 |

---

## 系统模块

### GET /api/health — 健康检查

无需登录，供 Docker healthcheck 和外部监控使用。

**成功响应** `200`
```json
{ "code": 0, "data": { "status": "ok", "uptime": 123.456 } }
```

| 字段 | 说明 |
|------|------|
| `status` | 固定为 `"ok"` |
| `uptime` | 进程已运行秒数（`process.uptime()`）|

---

## 错误码速查

| HTTP 状态码 | 含义 |
|------------|------|
| 400 | 请求参数错误 |
| 401 | 未登录或 Token 失效 |
| 403 | 无权限操作 |
| 404 | 资源不存在 |
| 409 | 资源冲突（如用户名重复）|
| 413 | 请求体超出大小限制（默认 100kb）|
| 429 | 请求过于频繁（触发限流）|
| 500 | 服务端内部错误 |
| 502 | 上游数据源（行情/Ollama）不可达 |
| 503 | SSE 连接数已满 |