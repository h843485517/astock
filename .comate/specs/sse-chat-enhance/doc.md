# SSE 全局配置 + 持仓 SSE + 投资顾问机器人

---

## 需求一：全局 SSE 时间配置

### 场景与处理逻辑
当前 `server.js` 中 `startIndexPolling(10000)` 硬编码轮询间隔，`quote.js` 心跳 25000ms 也是硬编码。需通过 `.env` 环境变量统一管理全仓 SSE 推送间隔，让用户一处配置、全局生效。

### 技术方案
- 在 `.env.example` 新增 `SSE_INTERVAL_MS=10000`（单位毫秒，默认 10000）
- `server.js` 读取 `process.env.SSE_INTERVAL_MS`，传入 `startIndexPolling()`
- `src/routes/quote.js` 的心跳间隔改为 `Math.min(SSE_INTERVAL_MS * 2.5, 30000)`，跟随主间隔动态调整
- 后续持仓 SSE、任何新增 SSE 路由均统一读取同一变量

### 影响文件
| 文件 | 修改类型 |
|---|---|
| `.env.example` | 新增 `SSE_INTERVAL_MS` 变量 |
| `server.js` | 读取环境变量，传参给 `startIndexPolling` |
| `src/routes/quote.js` | 心跳改为动态值 `SSE_HEARTBEAT_MS` |

### 实现细节
```js
// server.js
const SSE_INTERVAL_MS = parseInt(process.env.SSE_INTERVAL_MS || '10000', 10);
startIndexPolling(SSE_INTERVAL_MS);

// src/routes/quote.js — 顶部读取
const SSE_INTERVAL_MS  = parseInt(process.env.SSE_INTERVAL_MS || '10000', 10);
const SSE_HEARTBEAT_MS = Math.min(Math.round(SSE_INTERVAL_MS * 2.5), 30000);
// 替换原 25000 硬编码
const heartbeat = setInterval(() => sseWrite(': ping\n\n'), SSE_HEARTBEAT_MS);
```

---

## 需求二：持仓信息 SSE 实时推送

### 场景与处理逻辑
当前 `Home.vue` / `Positions.vue` 的持仓数据只能手动点"刷新"。需在后端新增 `/api/positions/stream` SSE 端点，按全局 `SSE_INTERVAL_MS` 周期推送最新持仓+行情数据，前端自动更新，同时保留手动刷新按钮。

### 技术方案
**后端**
- `src/routes/positions.js` 新增 `GET /api/positions/stream` SSE 路由
  - 连接建立 → 立即推一次全量持仓+行情
  - 之后每 `SSE_INTERVAL_MS` 再推一次
  - 客户端断开时 `clearInterval` + 计数器 `--`
  - 最大并发 100 连接，超出返回 503
- 持仓行情聚合逻辑提取为 `buildPositionPayload()` 函数，供 SSE 和 HTTP 共用
- `server.js` compression 过滤器同步增加 `/api/positions/stream` 跳过压缩

**前端**
- `Home.vue`：`onMounted` 时同时建立持仓 SSE（`/api/positions/stream`），收到推送直接更新 `positions` 和 `quotes`；手动刷新改为强制 HTTP 请求
- `Positions.vue`：同上，增加 SSE 连接，`onUnmounted` 时关闭；SSE 状态用一个 `sseActive` ref 显示状态指示器
- `client/src/api.js` 无需新增函数（EventSource 由页面直接创建）

### 影响文件
| 文件 | 修改类型 |
|---|---|
| `src/routes/positions.js` | 新增 SSE 路由、提取 `buildPositionPayload` |
| `server.js` | compression filter 增加 `/api/positions/stream` |
| `client/src/pages/Home.vue` | 增加持仓 SSE 连接与处理 |
| `client/src/pages/Positions.vue` | 增加持仓 SSE 连接与处理 |

### 实现细节
```js
// src/routes/positions.js — buildPositionPayload
async function buildPositionPayload() {
  const positions = await db.getAllPositions();
  const stockCodes = positions.filter(p => p.type === 'stock').map(p => p.code);
  const fundCodes  = positions.filter(p => p.type === 'fund').map(p => p.code);
  const quotes = {};
  if (stockCodes.length > 0) {
    try { Object.assign(quotes, await fetchStockQuote(stockCodes)); } catch (_) {}
  }
  for (const code of fundCodes) {
    try {
      const d = await fetchFundQuote(code);
      const pct = d.gszzl || 0;
      quotes[code] = { name: d.name, current: +(d.dwjz*(1+pct/100)).toFixed(4), close: d.dwjz, change_pct: pct };
    } catch (_) {}
  }
  return { positions, quotes };
}

// SSE 端点
router.get('/stream', async (req, res) => {
  if (positionSseCount >= MAX_SSE_CLIENTS) return res.status(503).json({...});
  positionSseCount++;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  function sseWrite(str) { res.write(str); if (typeof res.flush === 'function') res.flush(); }

  // 立即推一次
  try {
    const payload = await buildPositionPayload();
    sseWrite(`data: ${JSON.stringify({ code: 0, ...payload })}\n\n`);
  } catch (_) {}

  // 定时推送
  const timer = setInterval(async () => {
    try {
      const payload = await buildPositionPayload();
      sseWrite(`data: ${JSON.stringify({ code: 0, ...payload })}\n\n`);
    } catch (_) {}
  }, SSE_INTERVAL_MS);

  const heartbeat = setInterval(() => sseWrite(': ping\n\n'), SSE_HEARTBEAT_MS);

  req.on('close', () => { clearInterval(timer); clearInterval(heartbeat); positionSseCount--; });
});
```

```js
// Home.vue / Positions.vue — 持仓 SSE 订阅
let posEsSource = null;
function connectPositionSSE() {
  posEsSource = new EventSource('/api/positions/stream');
  posEsSource.onmessage = (e) => {
    const payload = JSON.parse(e.data);
    if (payload.code === 0) {
      positions.value = payload.positions;
      // 将 quotes 数组转为以 code 为 key 的对象
      quotes.value = payload.quotes;
    }
    loadingPos.value = false;
  };
  posEsSource.onerror = () => { /* 降级：手动刷新 */ };
}
onUnmounted(() => { if (posEsSource) posEsSource.close(); });
```

---

## 需求三：AI 投资顾问机器人

### 开源 LLM 选型说明
| 模型 | 中文金融表现 | 部署方式 |
|---|---|---|
| **Qwen2.5** (阿里千问) | ⭐⭐⭐⭐⭐ A股理解最佳，金融微调版本丰富 | Ollama |
| DeepSeek-R1 | ⭐⭐⭐⭐ 强推理，中文优秀，但无金融专项 | Ollama |
| FinGPT | ⭐⭐⭐ 英文金融专业，中文较弱 | HuggingFace |
| Yi-1.5 | ⭐⭐⭐⭐ 中文优，通用能力强 | Ollama |

**最终选用：Qwen2.5（通过 Ollama 本地部署）**，`OLLAMA_MODEL` 环境变量可切换具体版本（默认 `qwen2.5:7b`），`OLLAMA_BASE_URL` 指定 Ollama 服务地址（默认 `http://localhost:11434`）。

### 场景与处理逻辑
用户在聊天页面输入问题，系统自动拉取用户全部持仓数据 + 选中标的当日行情 + 近 30 日历史（新浪历史 K 线接口），构造包含持仓上下文的 Prompt 发给 Qwen2.5，返回流式（stream）投资建议。

### 技术方案
**后端**
- `src/services/chatService.js`（新建）
  - `buildContext(positions, quotes)` — 将持仓+行情格式化为中文 Prompt 上下文
  - `fetchStockHistory(code, days=30)` — 调新浪历史 K 线接口获取近 N 日 OHLCV 数据
  - `streamChat(userMessage, context, res)` — 调用 Ollama `/api/chat` 接口（流式），将 token 转发给前端 SSE
- `src/routes/chat.js`（新建）
  - `GET /api/chat/stream?message=...` — SSE 接口，接收用户问题，构造上下文，流式返回 AI 回复
  - `GET /api/chat/history-quote?code=&type=` — 获取指定标的历史行情（供前端展示迷你 K 线）
- `server.js` 注册 `chatRouter`，compression 过滤器增加 `/api/chat/stream`

**前端**
- `client/src/pages/Chat.vue`（新建）
  - 顶部：持仓选择器（多选 tag，点击选中后会将该标的加入上下文）
  - 中部：聊天消息列表（用户消息+AI回复，支持 Markdown 渲染，用 `<pre>` 简单处理）
  - 底部：输入框 + 发送按钮，Enter 发送，Shift+Enter 换行
  - AI 回复通过 EventSource 流式接收，逐 token 追加到消息气泡
  - 若 Ollama 未启动，返回友好错误提示（`OLLAMA_NOT_AVAILABLE`）
- `client/src/router/index.js` 新增 `/chat` 路由
- `client/src/App.vue` 导航栏新增"投资顾问"入口

### 影响文件
| 文件 | 修改类型 |
|---|---|
| `src/services/chatService.js` | 新建，Ollama 调用 + 上下文构造 + 历史行情 |
| `src/routes/chat.js` | 新建，SSE 聊天路由 + 历史行情路由 |
| `server.js` | 注册 chatRouter，compression 过滤器扩展 |
| `.env.example` | 新增 `OLLAMA_BASE_URL`, `OLLAMA_MODEL` |
| `client/src/pages/Chat.vue` | 新建，聊天 UI 页面 |
| `client/src/router/index.js` | 新增 `/chat` 路由 |
| `client/src/App.vue` | 导航栏新增"投资顾问"链接 |
| `client/src/api.js` | 新增 `getChatPositions` 辅助函数 |

### 核心实现细节

**Prompt 构建（chatService.js）**
```js
function buildContext(positions, quotes) {
  const lines = ['以下是用户当前全部持仓及今日行情：'];
  for (const p of positions) {
    const q = quotes[p.code] || {};
    const current = q.current || '--', pct = q.change_pct != null ? q.change_pct.toFixed(2)+'%' : '--';
    const profit = q.current ? ((q.current - p.cost_price) * p.shares).toFixed(2) : '--';
    lines.push(`- ${p.name||p.code}（${p.type==='fund'?'基金':'股票'} ${p.code}）：持有${p.shares}股/份，成本价${p.cost_price}，当前价${current}，今日涨跌${pct}，持有收益${profit}元`);
  }
  return lines.join('\n');
}

const SYSTEM_PROMPT = `你是一位专业的A股和基金投资顾问，熟悉中国资本市场。
请基于用户的持仓情况和行情数据，给出专业、客观的投资建议。
注意：你的建议仅供参考，不构成投资依据，请在回答中提醒用户注意风险。`;
```

**Ollama 流式调用**
```js
async function streamChat(userMessage, context, res) {
  const ollamaUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

  const response = await axios.post(`${ollamaUrl}/api/chat`, {
    model,
    stream: true,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: `${context}\n\n用户问题：${userMessage}` },
    ],
  }, { responseType: 'stream', timeout: 120000 });

  response.data.on('data', (chunk) => {
    const lines = chunk.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const token = obj?.message?.content || '';
        if (token) res.write(`data: ${JSON.stringify({ token })}\n\n`);
        if (obj.done) res.write('data: [DONE]\n\n');
      } catch (_) {}
    }
    if (typeof res.flush === 'function') res.flush();
  });
  response.data.on('end', () => res.end());
}
```

**Chat.vue 流式接收**
```js
async function sendMessage() {
  const msg = inputText.value.trim();
  if (!msg) return;
  messages.value.push({ role: 'user', content: msg });
  inputText.value = '';
  const aiMsg = { role: 'assistant', content: '' };
  messages.value.push(aiMsg);

  const codes = selectedCodes.value.join(',');
  const es = new EventSource(`/api/chat/stream?message=${encodeURIComponent(msg)}&codes=${codes}`);
  es.onmessage = (e) => {
    if (e.data === '[DONE]') { es.close(); return; }
    const { token } = JSON.parse(e.data);
    aiMsg.content += token;
  };
  es.onerror = () => { es.close(); aiMsg.content += '\n\n[连接中断，请检查 Ollama 服务是否启动]'; };
}
```

### 历史行情接口
```js
// 新浪历史 K 线：https://money.finance.sina.com.cn/quotes_service/api/json_v2.php
// ?symbol=sh600519&scale=240&ma=no&datalen=30
async function fetchStockHistory(code, days = 30) {
  const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php`
    + `?symbol=${code}&scale=240&ma=no&datalen=${days}`;
  const res = await axios.get(url, { headers: { Referer: 'http://finance.sina.com.cn' }, timeout: 8000 });
  // 返回格式: [{"day":"2025-03-12","open":"...","high":"...","low":"...","close":"...","volume":"..."},...]
  return res.data;
}
```

### 边界条件与异常处理
- Ollama 未启动 → axios 连接超时，捕获后推送 `{ error: 'OLLAMA_NOT_AVAILABLE' }` 事件，前端展示"AI 服务未启动，请先安装并运行 Ollama"
- 无持仓 → Prompt 中说明"用户暂无持仓，请提供通用建议"
- 历史行情接口失败 → 不影响主流程，跳过历史数据，只用当日行情构造上下文
- 用户问题超长（>500字）→ 后端截断并提示

### 预期成果
- 用户访问 `/chat` 页面，选择感兴趣的标的，输入"帮我分析一下我的持仓风险"，AI 流式输出专业投资建议
- 整个对话过程无需页面刷新，响应实时可见
- 若 Ollama 未运行，给出明确的安装引导提示

---

## 需求四：多用户账户体系与安全防护

### 场景与处理逻辑
当前系统无用户概念，所有人共享同一份持仓数据。需引入用户注册/登录，每个用户拥有独立持仓，同时覆盖密码安全、认证鉴权、防暴力破解、XSS/CSRF/越权、DDoS 全套防护。

### 技术方案

**数据库层**
- 新建 `users` 表：`id, username, password_hash, created_at, last_login_at`
- `positions` 表新增 `user_id INT UNSIGNED NOT NULL` 外键，所有查询过滤 `WHERE user_id = ?`
- `src/db/database.js` 新增 `createUser / findUserByUsername / updateLastLogin` 方法；所有持仓 CRUD 方法增加 `userId` 参数

**认证层 (`src/middleware/auth.js` 新建)**
- 使用 `jsonwebtoken`（JWT）签发 Token，`JWT_SECRET` 通过环境变量注入，默认强随机字符串（启动时若未配置则打印警告）
- Token 有效期 `JWT_EXPIRES_IN`（默认 `7d`），存储在 HttpOnly Cookie，防 XSS 窃取
- 中间件 `requireAuth`：校验 Cookie 中的 JWT，解析 `userId` 挂到 `req.user`，失效返回 401

**密码安全**
- 使用 `bcrypt`（cost factor 12）哈希存储密码，禁止明文
- 注册时校验密码强度：最少 8 位，含大小写和数字

**防暴力破解（登录专用限流）**
- 独立 `loginLimiter`：同一 IP 5 分钟内最多 10 次登录尝试，超出锁定 15 分钟，返回 429
- 登录失败不区分"用户名不存在"和"密码错误"（统一提示"用户名或密码错误"），防用户枚举

**XSS 防护**
- 所有用户输入（username、group_name 等）经 `DOMPurify`（后端用 `isomorphic-dompurify`）清洗
- CSP 头已由 helmet 托管（`contentSecurityPolicy: false` 改为配置模式，限制 `script-src 'self'`）
- HttpOnly + Secure Cookie 防 JS 读取

**CSRF 防护**
- 由于 Token 存 HttpOnly Cookie，API 全部使用 `Content-Type: application/json`，浏览器跨域预检自动阻断 CSRF
- 额外为写操作（POST/PUT/DELETE）校验 `Origin` 或 `Referer` 头与服务器域名一致

**越权防护**
- 所有持仓操作路由在 `requireAuth` 后，额外校验 `position.user_id === req.user.id`，不一致返回 403

**DDoS 防护**
- 全局 `apiLimiter` 已有（15 min / 300次），登录路由叠加更严格的 `loginLimiter`
- 新增 `slowDown` 中间件（`express-slow-down`）：超过阈值后逐步增加响应延迟，而非直接拒绝

**路由设计 (`src/routes/auth.js` 新建)**
```
POST /api/auth/register  — 注册（用户名+密码）
POST /api/auth/login     — 登录，颁发 HttpOnly Cookie
POST /api/auth/logout    — 清除 Cookie
GET  /api/auth/me        — 返回当前用户信息（用于前端初始化）
```

### 影响文件
| 文件 | 修改类型 |
|---|---|
| `src/db/database.js` | 新增 users 表 DDL、用户 CRUD、持仓方法增加 userId 参数 |
| `src/middleware/auth.js` | 新建，JWT 校验中间件 `requireAuth` |
| `src/routes/auth.js` | 新建，注册/登录/登出/me 路由 |
| `src/routes/positions.js` | 所有路由加 `requireAuth`，CRUD 传入 `req.user.id` |
| `server.js` | 注册 authRouter，cookie-parser，CSP 配置，loginLimiter |
| `.env.example` | 新增 `JWT_SECRET`, `JWT_EXPIRES_IN` |
| `client/src/pages/Login.vue` | 新建，登录/注册页面 |
| `client/src/router/index.js` | 新增 `/login` 路由，路由守卫（未登录跳转 /login） |
| `client/src/App.vue` | 显示当前用户名 + 登出按钮 |
| `client/src/api.js` | 新增 `login / register / logout / getMe` |
| `package.json` | 新增依赖：`bcrypt`, `jsonwebtoken`, `cookie-parser`, `express-slow-down` |

### 实现细节
```js
// src/middleware/auth.js
const jwt = require('jsonwebtoken');
const SECRET = process.env.JWT_SECRET;

module.exports = function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) return res.status(401).json({ code: 1, message: '未登录' });
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (_) {
    res.clearCookie('token');
    res.status(401).json({ code: 1, message: 'Token 无效或已过期，请重新登录' });
  }
};

// POST /api/auth/login
const bcrypt = require('bcrypt');
const { findUserByUsername } = require('../db/database');
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  const user = await findUserByUsername(username);
  const valid = user && await bcrypt.compare(password, user.password_hash);
  if (!valid) return fail(res, '用户名或密码错误', 401);
  const token = jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: EXPIRES_IN });
  res.cookie('token', token, { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 7*24*3600*1000 });
  ok(res, { username: user.username });
});
```

```js
// client/src/router/index.js — 路由守卫
router.beforeEach(async (to) => {
  if (to.path === '/login') return true;
  const me = await api.getMe().catch(() => null);
  if (!me) return '/login';
  return true;
});
```

### 边界条件与异常处理
- 用户名已存在 → 409 Conflict
- 密码强度不足 → 400，明确提示要求
- JWT_SECRET 未配置 → 启动时打印安全警告，使用临时随机 secret（重启后失效，提示配置持久化 secret）
- 数据库迁移：`positions` 表新增 `user_id` 列（`ALTER TABLE`），存量数据 `user_id` 设为 0（匿名用户，不可登录访问）

---

## 需求五：现代化页面样式重构

### 场景与处理逻辑
当前页面背景为网格纹样式，整体偏旧。重构为现代简洁风格：纯色/渐变背景、卡片投影、更精简的排版、无多余装饰性元素。

### 技术方案
- `client/src/assets/style.css`（主样式文件）全面重写：
  - **背景**：`body` 改为深色渐变 `linear-gradient(135deg, #0f0f1a 0%, #1a1a2e 50%, #16213e 100%)` 固定背景，不再使用 `background-image: repeating-linear-gradient`（网格）
  - **卡片**：`.table-wrap`, `.summary-bar`, `.tab-summary` 改为毛玻璃效果 `backdrop-filter: blur(12px); background: rgba(255,255,255,0.04); border: 1px solid rgba(255,255,255,0.08);`
  - **字体**：引入系统中文字体栈 `-apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif`，标题字重 600
  - **色系**：主色调 `#4f9cf9`（蓝），上涨 `#ff6b6b`（红），下跌 `#4ecdc4`（绿），符合 A 股习惯
  - **按钮**：圆角 `border-radius: 8px`，主按钮渐变背景，hover 有微小上移动效 `transform: translateY(-1px)`
  - **导航栏**：毛玻璃顶栏，logo + 用户名 + 导出按钮精简排列
  - **表格**：去掉边框线，改为行悬停高亮 `rgba(255,255,255,0.04)`，斑马纹去掉
  - **动效**：页面切换 `transition: opacity 0.2s`，加载骨架屏改为 shimmer 动画

### 影响文件
| 文件 | 修改类型 |
|---|---|
| `client/src/assets/style.css` | 全面重写，现代暗色简洁风 |
| `client/src/App.vue` | 导航栏结构微调，适配新样式 |

### 预期成果
- 无网格背景，深色渐变底色，卡片毛玻璃质感
- 整体视觉更精简、专业，与金融类应用气质一致

---

## 需求六：金融数据隐私遮罩

### 场景与处理逻辑
用户在公共场合使用时，不希望他人看到具体金额。需在 `Home.vue`、`Positions.vue`、`Chat.vue` 页面顶部提供一个"显示/隐藏金额"切换按钮，点击后所有金额字段替换为 `****`，再次点击恢复。

### 技术方案
- 创建全局状态 `client/src/composables/usePrivacy.js`（Vue 3 Composable）
  - 导出 `privacyMode`（ref，默认 `false`）和 `togglePrivacy()`
  - 使用 `localStorage` 持久化用户偏好
- 创建格式化函数 `fmtPrivate(value, formatter)`：`privacyMode.value ? '****' : formatter(value)`
- 需要隐藏的字段：总资产、累计收益、今日盈亏、持仓总金额、当日收益、持有收益
- 在 `App.vue` 导航栏放置切换按钮（👁/👁‍🗨图标），所有页面共享同一状态

### 影响文件
| 文件 | 修改类型 |
|---|---|
| `client/src/composables/usePrivacy.js` | 新建，隐私模式全局状态 |
| `client/src/App.vue` | 导航栏增加切换按钮 |
| `client/src/pages/Home.vue` | 金额字段使用 `fmtPrivate` 包装 |
| `client/src/pages/Positions.vue` | 金额字段使用 `fmtPrivate` 包装 |

### 实现细节
```js
// client/src/composables/usePrivacy.js
import { ref } from 'vue';
const privacyMode = ref(localStorage.getItem('privacyMode') === 'true');
export function usePrivacy() {
  function togglePrivacy() {
    privacyMode.value = !privacyMode.value;
    localStorage.setItem('privacyMode', privacyMode.value);
  }
  return { privacyMode, togglePrivacy };
}

// Home.vue / Positions.vue 使用示例
import { usePrivacy } from '../composables/usePrivacy.js';
const { privacyMode } = usePrivacy();
const fmtPrivate = (v, fmt) => privacyMode.value ? '****' : fmt(v);
// 模板中：{{ fmtPrivate(summary.totalAsset, fmtMoney) }}
```

```html
<!-- App.vue 切换按钮 -->
<button class="btn-icon" @click="togglePrivacy" :title="privacyMode ? '显示金额' : '隐藏金额'">
  {{ privacyMode ? '👁‍🗨' : '👁' }}
</button>
```

### 预期成果
- 点击导航栏眼睛图标，所有金融数字瞬间变为 `****`
- 偏好持久化，刷新后保持上次设置
- Chat 页面的持仓上下文中，若隐私模式开启，向 AI 发送时仍使用真实数值（隐藏仅影响前端显示）