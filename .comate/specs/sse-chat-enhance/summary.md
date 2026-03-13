# 完成总结：A股追踪器全功能增强

## 构建结果
✅ `npm run build` 零错误，31 个模块全部编译通过，产物 130KB（gzip 49KB）

---

## 完成内容

### 需求一：全局 SSE 时间配置
- `.env.example` 新增 `SSE_INTERVAL_MS=10000`
- `server.js` 读取环境变量后传入 `startIndexPolling(SSE_INTERVAL_MS)`
- `src/routes/quote.js` 心跳间隔改为 `min(SSE_INTERVAL_MS × 2.5, 30000)`，不再硬编码 25000ms
- 后续所有 SSE 路由统一从同一变量读取，一处配置全局生效

### 需求二：持仓 SSE 实时推送
- `src/routes/positions.js` 新增 `GET /api/positions/stream` SSE 端点
- 提取 `buildPositionPayload(userId)` 聚合函数（拉持仓 + 行情），SSE 推送与 HTTP 响应共用
- 连接建立时立即推送一次，之后按 `SSE_INTERVAL_MS` 定时推送，带心跳防断连
- `Home.vue` / `Positions.vue` 均接入持仓 SSE，在线时显示 `实时` 绿色指示器，保留手动刷新

### 需求三：AI 投资顾问机器人（Qwen2.5 via Ollama）
- 新建 `src/services/chatService.js`：上下文构建、新浪历史K线拉取、Ollama 流式调用
- 新建 `src/routes/chat.js`：`GET /api/chat/stream`（SSE 流式回复）、`GET /api/chat/history-quote`
- 新建 `client/src/pages/Chat.vue`：持仓 tag 多选、流式消息气泡、打字光标动画、Ollama 安装引导
- 模型通过 `OLLAMA_MODEL` 环境变量切换（默认 `qwen2.5:7b`）

### 需求四：多用户账户体系与全套安全防护
- **数据库**：新增 `users` 表，`positions` 表增加 `user_id`，存量数据 ALTER TABLE 兼容
- **认证**：JWT 存 HttpOnly Cookie，`src/middleware/auth.js` 统一鉴权
- **密码安全**：bcrypt cost=12，注册强度校验（≥8位，含大小写+数字）
- **防暴力破解**：登录专用限流（5分钟10次），失败信息统一避免用户枚举
- **CSRF**：HttpOnly Cookie + JSON Content-Type 跨域预检自动阻断
- **越权**：所有持仓路由校验 `user_id === req.user.id`，不一致返回 403
- **DDoS**：全局限流保留（15min/300次），登录叠加更严格限流
- **CSP**：helmet 改为配置模式，限制 script/style/font 来源
- 新建 `src/routes/auth.js`（注册/登录/登出/me）、`client/src/pages/Login.vue`
- 前端路由守卫：所有非 `/login` 路由自动校验登录态

### 需求五：现代化页面样式重构
- `client/src/assets/style.css` 全面重写（~350行）
- 深色渐变背景取代网格纹，卡片改为毛玻璃效果（backdrop-filter）
- 统一色系：主色蓝 `#4f9cf9`，上涨红 `#ff6b6b`，下跌绿 `#4ecdc4`
- 按钮圆角 + hover 上移动效，表格去边框改行悬停高亮
- 骨架屏改为 shimmer 动画，新增 `.badge-sse` / `.btn-icon` 等工具类

### 需求六：金融数据隐私遮罩
- 新建 `client/src/composables/usePrivacy.js`，模块级单例，`localStorage` 持久化
- `App.vue` 导航栏增加 👁 切换按钮，所有页面共享同一状态
- `Home.vue` / `Positions.vue` 所有金额字段（总资产、收益、今日盈亏、持仓金额等）通过 `fmtPrivate()` 包装，一键切换显示/隐藏为 `****`

---

## 新增文件清单
| 文件 | 说明 |
|---|---|
| `src/middleware/auth.js` | JWT 认证中间件 |
| `src/routes/auth.js` | 注册/登录/登出/me 路由 |
| `src/routes/chat.js` | AI 聊天 SSE 路由 |
| `src/services/chatService.js` | Ollama 调用 + 上下文构建 + 历史行情 |
| `client/src/pages/Login.vue` | 登录/注册页面 |
| `client/src/pages/Chat.vue` | AI 投资顾问聊天页面 |
| `client/src/composables/usePrivacy.js` | 隐私遮罩全局状态 |

## 修改文件清单
| 文件 | 主要变更 |
|---|---|
| `src/db/database.js` | users 表、positions user_id、用户 CRUD |
| `src/routes/positions.js` | requireAuth、userId 隔离、SSE 端点 |
| `src/routes/quote.js` | SSE 心跳动态化 |
| `server.js` | cookie-parser、authRouter、chatRouter、CSP、SSE_INTERVAL_MS |
| `client/src/api.js` | credentials:'include'、认证接口 |
| `client/src/router/index.js` | /login、/chat 路由、全局守卫 |
| `client/src/App.vue` | 导航栏重构、隐私按钮、登出 |
| `client/src/assets/style.css` | 全面重写现代暗色风格 |
| `client/src/pages/Home.vue` | 持仓 SSE、隐私遮罩 |
| `client/src/pages/Positions.vue` | 持仓 SSE、隐私遮罩、onUnmounted |
| `.env.example` | SSE_INTERVAL_MS、JWT_SECRET、OLLAMA_* |
| `package.json` | bcrypt、jsonwebtoken、cookie-parser、express-slow-down |

---

## 使用说明

### 启动前置步骤
```bash
# 1. 配置环境变量
cp .env.example .env
# 编辑 .env，至少设置 JWT_SECRET 为强随机字符串

# 2. （可选）启动 Ollama AI 服务
ollama serve
ollama pull qwen2.5:7b

# 3. 构建前端并启动
npm run build && npm start
```

### AI 顾问说明
- 需要本地安装 [Ollama](https://ollama.ai)，默认使用 `qwen2.5:7b` 模型
- 可通过 `OLLAMA_MODEL` 环境变量切换模型版本（如 `qwen2.5:14b` 效果更好）
- 未启动 Ollama 时页面会展示安装引导，不影响其他功能使用