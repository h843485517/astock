# A股追踪器全功能增强：SSE配置 + 持仓推送 + AI顾问 + 多用户 + UI重构 + 隐私遮罩

- [x] 任务 1：安装新增依赖并更新 .env.example
    - 1.1: 执行 `npm install bcrypt jsonwebtoken cookie-parser express-slow-down` 安装后端新依赖
    - 1.2: 在 `.env.example` 新增 `SSE_INTERVAL_MS=10000`、`JWT_SECRET=your_jwt_secret_here`、`JWT_EXPIRES_IN=7d`、`OLLAMA_BASE_URL=http://localhost:11434`、`OLLAMA_MODEL=qwen2.5:7b` 五个变量并补充注释

- [x] 任务 2：数据库层扩展——users 表 + positions 增加 user_id
    - 2.1: 在 `src/db/database.js` 的 `initDatabase` 中新增 `users` 表 DDL（字段：id, username, password_hash, created_at, last_login_at）
    - 2.2: `initDatabase` 中对 `positions` 表执行 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS user_id INT UNSIGNED NOT NULL DEFAULT 0`，兼容存量数据
    - 2.3: 新增 `createUser(username, passwordHash)`、`findUserByUsername(username)`、`updateLastLogin(id)` 三个异步方法
    - 2.4: 所有持仓 CRUD 方法（`getAllPositions`、`createPosition`、`updatePosition`、`deletePosition`、`getPositionById`）增加 `userId` 参数，查询均加上 `WHERE user_id = ?` 过滤条件，防止越权

- [x] 任务 3：认证中间件与鉴权路由
    - 3.1: 新建 `src/middleware/auth.js`，实现 `requireAuth` 中间件：从 `req.cookies.token` 提取 JWT，验证签名，失败返回 401 并清除 Cookie
    - 3.2: 新建 `src/routes/auth.js`，实现 `POST /register`（bcrypt hash + createUser，密码强度校验：≥8位含大小写数字）、`POST /login`（compare + 签发 HttpOnly Cookie，loginLimiter 防暴力破解：5分钟10次）、`POST /logout`（清除 Cookie）、`GET /me`（返回当前用户 username）
    - 3.3: `server.js` 引入 `cookie-parser` 中间件、注册 `authRouter`（`/api/auth`）、将 helmet CSP 从 `false` 改为配置对象（允许 CDN 字体、self 脚本），compression 过滤器追加 `/api/positions/stream` 和 `/api/chat/stream`

- [x] 任务 4：持仓路由接入用户隔离
    - 4.1: `src/routes/positions.js` 所有路由前置 `requireAuth` 中间件，从 `req.user.id` 获取 userId 传入所有 DB 调用
    - 4.2: PUT/DELETE 路由先查出记录，校验 `record.user_id === req.user.id`，不一致返回 403 越权错误
    - 4.3: 新增持仓 SSE 端点 `GET /stream`：读取 `SSE_INTERVAL_MS` / `SSE_HEARTBEAT_MS`，`requireAuth` 鉴权，调用 `buildPositionPayload(userId)` 立即推送一次，之后定时推送，断开时清理计时器和计数器；提取 `buildPositionPayload(userId)` 聚合函数（拉持仓+行情）

- [x] 任务 5：全局 SSE 时间配置生效
    - 5.1: `server.js` 读取 `SSE_INTERVAL_MS = parseInt(process.env.SSE_INTERVAL_MS || '10000', 10)`，传给 `startIndexPolling(SSE_INTERVAL_MS)`
    - 5.2: `src/routes/quote.js` 顶部读取 `SSE_INTERVAL_MS` 并计算 `SSE_HEARTBEAT_MS = Math.min(Math.round(SSE_INTERVAL_MS * 2.5), 30000)`，将路由中硬编码的 `25000` 替换为 `SSE_HEARTBEAT_MS`

- [x] 任务 6：AI 聊天服务层（chatService.js）
    - 6.1: 新建 `src/services/chatService.js`，实现 `fetchStockHistory(code, days=30)` 调新浪历史K线接口，失败时静默返回空数组
    - 6.2: 实现 `buildContext(positions, quotes, historiesMap)` 将持仓/行情/历史格式化为中文 Prompt 上下文字符串
    - 6.3: 实现 `streamChat(userMessage, context, res)` 调用 Ollama `/api/chat` 流式接口，逐行解析 token 推送 SSE 事件，完成时推送 `[DONE]`；Ollama 不可达时推送 `{ error: 'OLLAMA_NOT_AVAILABLE' }` 后结束

- [x] 任务 7：聊天路由（chat.js）
    - 7.1: 新建 `src/routes/chat.js`，`GET /stream` 路由加 `requireAuth`，接收 `message`（限 500 字）和 `codes`（可选，逗号分隔），拉取用户持仓+指定标的历史，构建上下文，调用 `streamChat` 流式响应
    - 7.2: `GET /history-quote` 路由：接收 `code` 和 `type`，调 `fetchStockHistory`，返回 JSON 历史数据
    - 7.3: `server.js` 注册 `chatRouter`（`/api/chat`）

- [x] 任务 8：前端 API 层与路由扩展
    - 8.1: `client/src/api.js` 新增 `login(data)`、`register(data)`、`logout()`、`getMe()` 四个接口函数，统一携带 `credentials: 'include'` 保证 Cookie 传送
    - 8.2: `client/src/router/index.js` 新增 `/login` 和 `/chat` 路由，添加全局 `beforeEach` 路由守卫：非 `/login` 路由调 `getMe()` 验证登录态，未登录跳转 `/login`

- [x] 任务 9：登录/注册页面（Login.vue）
    - 9.1: 新建 `client/src/pages/Login.vue`，包含登录和注册两个 Tab，表单校验（密码强度提示），调用 `api.login` / `api.register`，成功后跳转 `/`
    - 9.2: 登录页使用与主题一致的暗色毛玻璃卡片居中布局，品牌 logo 标题，错误信息行内展示

- [x] 任务 10：隐私遮罩 Composable 与 App.vue 改造
    - 10.1: 新建 `client/src/composables/usePrivacy.js`，模块级单例 `privacyMode` ref，`localStorage` 持久化，导出 `{ privacyMode, togglePrivacy }`
    - 10.2: `client/src/App.vue` 重构导航栏结构：左侧 logo + 路由链接（首页/持仓/投资顾问），右侧隐私切换按钮（👁图标）+ 当前用户名 + 登出按钮；引入 `usePrivacy` 和 `useRouter`，登出调 `api.logout()` 后跳转 `/login`

- [x] 任务 11：现代化 CSS 样式全面重写
    - 11.1: 全面重写 `client/src/assets/style.css`：CSS 变量定义色板（主色/上涨/下跌/背景/卡片/文字）、body 深色渐变背景（去除网格）、导航栏毛玻璃样式
    - 11.2: 卡片/表格/摘要栏改为毛玻璃效果（backdrop-filter + 半透明背景 + 微边框）、按钮统一圆角+hover动效、表格去边框改悬停高亮
    - 11.3: 骨架屏改为 shimmer 动画、loading spinner 样式优化、tab-bar 活跃态改为下划线+主色高亮
    - 11.4: 新增 `.btn-icon`（图标按钮）、`.badge-sse`（SSE 状态指示器）等工具类

- [x] 任务 12：Home.vue 接入持仓 SSE + 隐私遮罩
    - 12.1: 引入 `usePrivacy`，所有金额展示（总资产、累计收益、今日盈亏、持仓总金额、当日收益、持有收益）改用 `fmtPrivate(val, fmtMoney)` 包装
    - 12.2: `onMounted` 时建立持仓 SSE 连接（`/api/positions/stream`，带 `credentials:'include'`），收到推送更新 `positions`、`quotes`；`onUnmounted` 关闭
    - 12.3: 手动刷新按钮改为调用 HTTP 接口强制刷新，保留原有功能；SSE 在线时显示 `.badge-sse` 绿色指示器

- [x] 任务 13：Positions.vue 接入持仓 SSE + 隐私遮罩
    - 13.1: 引入 `usePrivacy`，所有金额字段改用 `fmtPrivate` 包装
    - 13.2: `onMounted` 建立持仓 SSE，`onUnmounted` 关闭，SSE 推送时更新 `positions` 和 `quotes`，同时保留手动刷新
    - 13.3: 导入 `onUnmounted`（当前缺失），补全组件生命周期管理

- [x] 任务 14：Chat.vue 聊天机器人页面
    - 14.1: 新建 `client/src/pages/Chat.vue`，顶部持仓 tag 选择器（自动加载当前用户持仓），展示代码和名称，点击切换选中态（选中的标的会加入历史行情上下文）
    - 14.2: 消息列表区域：用户消息右侧气泡（主色），AI 消息左侧气泡（卡片色），支持 `\n` 换行渲染，流式追加时末尾显示打字光标动画
    - 14.3: 底部输入区：多行 textarea（Enter发送，Shift+Enter换行），发送按钮，发送中禁用；通过 EventSource 流式接收 token 并追加到 AI 消息，`[DONE]` 时关闭连接
    - 14.4: Ollama 不可达时展示安装引导卡片（包含 `ollama pull qwen2.5:7b` 命令提示）；无持仓时展示引导添加持仓提示
