# 📈 A股实时收益追踪器

一个基于 Node.js + Vue 3 的全栈 Web 应用，用于追踪 A 股市场股票与基金的实时持仓收益情况，内置 AI 投资顾问（双模式：免费云端 API / VIP 本地 Ollama）。

- 📊 **大盘指数**：SSE 实时推送上证、深证、创业板等 6 只 A 股指数 + 3 只全球指数（道琼斯/纳斯达克/标普500），断线自动指数退避重连，最终降级为轮询
- 💼 **持仓管理**：多用户独立持仓，支持股票/基金，自定义分组，SSE 自动刷新；支持名称/代码模糊搜索过滤；支持列排序（持仓金额/当日净值/当日收益/持有收益）
- 💰 **收益计算**：实时显示持仓市值、累计收益、今日盈亏；今日涨跌幅以昨日快照资产为基准，无快照时降级为行情估算
- 🔔 **止损 / 目标价提醒**：每笔持仓可设置止损价与目标价，触发时页面弹出 Toast 提醒，同一笔仅提醒一次（恢复后可再次触发）
- 📅 **收益历史日历**：月度收益日历，展示每日盈亏/涨跌幅，月统计（盈利天数/亏损天数/月累计盈亏/最新总资产），点击日期查看当日详情抽屉
- 💾 **自动快照归档**：交易时段（09:25–15:10）内每 10 分钟节流自动存档，收盘时（15:05）精确触发最终快照，全程无需手动操作
- 🤖 **AI 投资顾问（双模式）**：结合持仓行情与近 30 日历史 K 线给出流式投资建议；支持多轮对话（最近 10 轮上下文）、可多选标的聚焦分析、支持中断输出、对话记录 localStorage 持久化；**免费用户** 通过 OpenAI 兼容 API（SiliconFlow / DeepSeek 等）调用开源模型，**VIP 用户** 使用本地 Ollama 高级模型，前后端全程感知区分
- 👤 **多用户账户**：注册/登录，JWT 认证（HttpOnly + SameSite=Strict Cookie），bcrypt（cost=12）密码哈希，支持修改密码，防时序攻击
- 🔒 **隐私遮罩**：一键隐藏所有金融数字（总资产/收益/盈亏等），偏好 localStorage 持久化
- 🌓 **明暗主题切换**：支持深色/浅色模式，偏好 localStorage 持久化
- 🎨 **现代 UI**：深色渐变背景，毛玻璃卡片，响应式设计，移动端底部 Tab Bar，骨架屏加载态，页面切换过渡动画

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Node.js + Express.js（cluster 多核，生产模式自动 fork） |
| 数据库 | MySQL（mysql2/promise，连接池，预编译防 SQL 注入）|
| 认证 | JWT（jsonwebtoken）+ bcrypt + HttpOnly Cookie |
| 前端 | Vue 3 Composition API + Vue Router 4（Vite 构建）|
| 实时推送 | SSE（Server-Sent Events）—— 大盘指数 + 持仓行情 + AI 流式输出 |
| AI | Ollama（VIP，本地高级模型）/ OpenAI 兼容 API（免费，SiliconFlow / DeepSeek 等） |
| 行情数据 | 新浪财经（主，股票/指数，GBK 解码）/ 腾讯财经（备用，自动降级）/ 天天基金（基金估值）|
| 安全 | helmet CSP + express-rate-limit 分级限流 + gzip 压缩 |

## 快速开始

### 前置要求

- Node.js >= 20
- pnpm >= 9（`npm install -g pnpm` 或 `corepack enable`）
- MySQL 5.7+（或 MySQL 8）
- （可选）[Ollama](https://ollama.ai) ——启用 AI 投资顾问功能

### 启动步骤

```bash
# 1. 安装依赖
pnpm install

# 2. 配置环境变量（首次使用必做）
cp .env.example .env
# 编辑 .env，至少填写以下几项：
MYSQL_USER=你的MySQL用户名
MYSQL_PASSWORD=你的MySQL密码
JWT_SECRET=（用下方命令生成64位随机字符串）
 # node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
OPENAI_API_KEY=sk-替换为你的APIKey

# 3. 启动开发模式（推荐，带热更新）
pnpm run dev
```

访问 [http://localhost:5173](http://localhost:5173)（Vite 开发服务器），注册账号后开始使用。

> 首次启动会自动创建数据库表结构，无需手动执行 SQL。

### 生产模式启动

```bash
# 构建前端 + 启动 Node.js 服务器
pnpm run build
pnpm start
```

访问 [http://localhost:3000](http://localhost:3000)。

> **`pnpm start` 的作用**：生产模式下会自动以 `cluster` 多核模式启动（worker 数 = CPU 核心数），worker 崩溃后自动重启。开发时请用 `pnpm run dev` 享受 Vite 热更新。

### 启用 AI 投资顾问

AI 投资顾问支持两种模式，按用户身份自动路由：

#### 🆓 免费模式（推荐，无需部署 Ollama）

通过 OpenAI 兼容接口（如 SiliconFlow、DeepSeek）调用云端开源模型，适合内存受限的 ECS 服务器。

在 `.env` 中配置以下环境变量：

```env
# 推荐：智谱 AI（GLM-4-Flash 完全免费，注册即用）
OPENAI_API_BASE=https://open.bigmodel.cn/api/paas/v4
OPENAI_API_KEY=sk-你的APIKey
OPENAI_FREE_MODEL=GLM-4-Flash-250414
```

> **推荐首选：[智谱 AI](https://open.bigmodel.cn)**（`GLM-4-Flash-250414` 和 `GLM-Z1-Flash` 永久免费，无需充值，注册后在控制台 → API 密钥处申请）
>
> 其他可选平台：[SiliconFlow](https://siliconflow.cn)（Qwen/DeepSeek 系列）、[DeepSeek](https://platform.deepseek.com)

#### 👑 VIP 模式（本地 Ollama，高质量）

需要部署 Ollama，适合有足够内存的服务器（建议 ≥ 4GB 空闲内存）。

```bash
# 安装 Ollama（macOS）
brew install ollama

# 启动服务
ollama serve

# 拉取推荐模型（约 1.9GB，轻量且中文能力强）
ollama pull qwen2.5:3b

# 如需更高质量，可改用 7b（约 4.4GB）
# ollama pull qwen2.5:7b
```

通过以下命令将用户升级为 VIP 即可享受本地 Ollama 模式：

```bash
node scripts/test-ai.js set-vip 你的用户名
```

## Docker 部署

```bash
# 构建镜像
docker build -t astock-tracker .

# 运行容器（需配置环境变量）
docker run -p 3000:3000 \
  -e MYSQL_HOST=host.docker.internal \
  -e MYSQL_USER=root \
  -e MYSQL_PASSWORD=your_password \
  -e JWT_SECRET=your_secret \
  astock-tracker

# 或使用 docker-compose（含 MySQL 服务）
docker-compose up -d
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口 |
| `NODE_ENV` | `production` | 运行环境（`development` 时禁用 cluster）|
| `MYSQL_HOST` | `localhost` | MySQL 地址 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `MYSQL_USER` | `root` | MySQL 用户名 |
| `MYSQL_PASSWORD` | `` | MySQL 密码 |
| `MYSQL_DATABASE` | `astock` | 数据库名 |
| `MYSQL_CONN_LIMIT` | `10` | MySQL 连接池大小 |
| `JWT_SECRET` | *(必填)* | JWT 签名密钥，建议 64 位以上随机字符串 |
| `JWT_EXPIRES_IN` | `7d` | Token 有效期 |
| `COOKIE_MAX_AGE_MS` | `604800000` | Cookie 有效期（毫秒，默认 7 天）|
| `SSE_INTERVAL_MS` | `10000` | SSE 推送间隔（毫秒）|
| `MAX_SSE_CLIENTS` | `100` | 持仓 SSE 最大并发连接数 |
| `QUOTE_CACHE_TTL_MS` | `60000` | 持仓行情缓存有效期（毫秒）|
| `RATE_LIMIT_API_MAX` | `300` | 全局 API 限流（15 分钟内）|
| `RATE_LIMIT_LOGIN_MAX` | `10` | 登录限流（5 分钟内，成功不计）|
| `RATE_LIMIT_REGISTER_MAX` | `5` | 注册限流（1 小时内）|
| `REQUEST_BODY_LIMIT` | `100kb` | 请求体大小上限 |
| `HTTPS_ENABLED` | `false` | 是否启用完整 CSP + HSTS（HTTPS 部署时设为 `true`）|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 服务地址（VIP 模式）|
| `OLLAMA_MODEL` | `qwen2.5:3b` | VIP 模式 AI 模型（推荐 3b，可换 7b 提升质量）|
| `OPENAI_API_BASE` | `https://open.bigmodel.cn/api/paas/v4` | 免费模式 OpenAI 兼容接口地址（智谱 AI）|
| `OPENAI_API_KEY` | `` | 免费模式 API Key（必填，否则免费 AI 不可用）|
| `OPENAI_FREE_MODEL` | `GLM-4-Flash-250414` | 免费模式使用的模型名称 |
| `BCRYPT_ROUNDS` | `12` | bcrypt 哈希强度 |

## 项目结构

```
├── server.js                    # Express 服务入口（cluster 多核 + 全局中间件）
├── src/
│   ├── db/database.js           # MySQL 连接池 + 建表 DDL + 全部 CRUD 方法
│   ├── middleware/
│   │   └── auth.js              # JWT 认证中间件（requireAuth）
│   ├── routes/
│   │   ├── auth.js              # 注册/登录/登出/me/修改密码（含分级限流）
│   │   ├── positions.js         # 持仓 CRUD + SSE 实时推送（止损/目标价字段）
│   │   ├── quote.js             # 行情代理（股票/基金/大盘）+ 大盘 SSE
│   │   ├── history.js           # 收益快照 CRUD（按月/按范围/按日期查询）
│   │   └── chat.js              # AI 聊天 SSE 路由（多轮对话 + 历史行情上下文）
│   └── services/
│       ├── quoteService.js      # 行情抓取（新浪主/腾讯备，自动降级）+ 内存缓存 + 大盘轮询广播
│       └── chatService.js       # AI 调用（VIP→Ollama / 免费→OpenAI兼容API）+ 持仓上下文 + 历史K线
├── client/src/
│   ├── pages/
│   │   ├── Home.vue             # 首页（资产概览 + 持仓速览 + 大盘 + 自动快照）
│   │   ├── Positions.vue        # 持仓管理（搜索过滤 + 列排序 + 分组 Tab + 止损目标价提醒 + 编辑弹窗）
│   │   ├── AddPosition.vue      # 添加持仓（实时代码验证 + 分组选择/新建）
│   │   ├── Login.vue            # 登录/注册（密码强度实时校验）
│   │   ├── History.vue          # 收益历史日历（月统计 + 日历格子 + 详情抽屉）
│   │   └── Chat.vue             # AI 投资顾问（多轮对话 + 标的多选 + 历史持久化）
│   ├── components/
│   │   └── MarketIndex.vue      # 大盘指数组件（A股 + 全球指数展示）
│   ├── composables/
│   │   ├── useFormat.js         # 统一格式化（金额/百分比/千分位/隐私遮罩/涨跌色）
│   │   ├── usePrivacy.js        # 隐私遮罩全局单例状态
│   │   └── usePositionStream.js # 持仓 SSE 流 + 手动刷新 composable（Home/Positions 共用）
│   ├── router/index.js          # 路由配置 + 全局登录态守卫
│   ├── api.js                   # 前端 API 封装（持仓/行情/认证/历史快照）
│   └── assets/style.css         # 全局样式（CSS 变量 + 深色/浅色模式 + 响应式）
├── scripts/
│   └── test-ai.js               # AI 模式本地测试工具（验证免费/VIP 模式 + 切换用户 VIP 状态）
├── vite.config.js               # Vite 配置（代理 /api → :3000，别名 @）
├── docker-compose.yml
└── Dockerfile
```

## API 说明

完整接口文档（请求参数、响应格式、限流规则、错误码等）详见：

📄 [docs/api.md](docs/api.md)

### 接口概览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/register` | 注册（限流：1h/5次）|
| POST | `/api/auth/login` | 登录（限流：5min/10次）|
| POST | `/api/auth/logout` | 登出（清除 Cookie）|
| GET  | `/api/auth/me` | 获取当前登录用户信息 |
| PUT  | `/api/auth/password` | 修改密码 |
| GET  | `/api/positions` | 获取所有持仓 |
| GET  | `/api/positions/stream` | SSE 持仓实时推送（需登录）|
| POST | `/api/positions` | 新增持仓 |
| PUT  | `/api/positions/:id` | 修改持仓（含止损/目标价）|
| DELETE | `/api/positions/:id` | 删除持仓 |
| GET  | `/api/quote?codes=` | 批量获取股票行情 |
| GET  | `/api/fund-quote?code=` | 获取基金估值 |
| GET  | `/api/market-index` | 获取大盘指数（一次性）|
| GET  | `/api/market-index/stream` | SSE 大盘实时推送 |
| POST | `/api/history/snapshot` | 保存当日收益快照 |
| GET  | `/api/history/snapshots` | 按年月查询快照列表 |
| GET  | `/api/history/snapshots/range` | 按日期范围查询快照 |
| GET  | `/api/history/snapshots/:date` | 查询指定日期快照 |
| POST | `/api/chat/stream` | AI 对话 SSE 流（POST，请求体传参）|
| GET  | `/api/chat/history-quote` | 获取标的近 30 日历史行情 |
| GET  | `/api/health` | 健康检查（无需登录，供监控/Docker 使用）|

## 安全说明

- 密码使用 bcrypt（cost=12）哈希存储，从不明文传输
- JWT 存于 HttpOnly + SameSite=Strict Cookie，防 XSS 窃取
- **修改密码后旧 Token 立即失效**：`users` 表维护 `token_version`，改密码时自增；`requireAuth` 中间件在 JWT 验证通过后比对版本号，不匹配返回 401，使其他设备上的旧登录会话同步失效
- 登录接口独立限流（5分钟/10次），成功登录不计入次数；注册独立限流（1小时/5次）
- 登录时无论用户是否存在均执行 bcrypt.compare，防止时序攻击
- 所有持仓操作强制校验 `user_id`，防止越权访问
- **Chat XSS 加固**：AI 回复内容经完整 HTML 转义（`&`、`<`、`>`、`"`、`'`），防止 AI 生成内容注入 DOM
- **持仓接口错误脱敏**：所有 `catch` 块返回通用提示，内部 DB 错误仅记录至服务端日志，不暴露给客户端
- helmet CSP 限制脚本/样式/字体来源，防注入攻击；HTTPS 部署时自动启用 HSTS
- 请求体限制 100kb，防超大请求攻击
- 全局 API 限流（15分钟/300次），防暴力爬取
- 所有数据库操作使用预编译语句（Prepared Statements），防 SQL 注入

## 已知限制 / 待办事项

以下功能当前尚未实现，可按需扩展：

| 类别 | 说明 |
|---|---|
| 📤 数据导入/导出 | 暂不支持批量导入持仓（CSV/Excel）或导出持仓/历史数据 |
| 📈 趋势图表 | 历史收益日历有详情抽屉，但无折线图/柱状图趋势可视化 |
| 🔔 消息推送 | 止损/目标价仅页内 Toast，无浏览器通知（Notification API）或微信/邮件推送 |
| 📊 持仓分析 | 无行业/板块分布饼图、资产配置占比等分析视图 |
| 📝 交易记录 | 无买入/卖出交易流水记录，仅维护当前持仓快照 |
| 👥 管理员功能 | 无后台管理界面（VIP 升级/降级、用户管理/数据统计等），需直接操作数据库 |
| 🔑 第三方登录 | 仅支持用户名/密码登录，无 OAuth 接入 |

## 本地开发工具

### AI 模式测试脚本

项目内置了 `scripts/test-ai.js`，可在不启动完整服务的情况下快速验证 AI 配置、切换用户 VIP 状态：

```bash
# 测试免费模式（智谱 AI）—— 直接连接云端，无需启动项目
node scripts/test-ai.js free

# 测试 VIP 模式（Ollama）—— 需先执行 ollama serve
node scripts/test-ai.js vip

# 查看所有用户的 VIP 状态
node scripts/test-ai.js list

# 将指定用户升级为 VIP（页面 Chat 变为 👑 VIP · Ollama）
node scripts/test-ai.js set-vip admin

# 将指定用户降回免费（页面 Chat 变为 🆓 免费 · GLM-4-Flash-250414）
node scripts/test-ai.js set-free admin
```

> 切换 VIP 状态后**刷新页面**即可生效，无需重启服务。