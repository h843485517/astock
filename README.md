# 📈 A股实时收益追踪器

一个基于 Node.js + Vue 3 的全栈 Web 应用，用于追踪 A 股市场股票与基金的实时持仓收益情况，内置 AI 投资顾问。

## 功能特性

- 📊 **大盘指数**：SSE 实时推送上证、深证、创业板等 6 只 A 股指数 + 3 只全球指数
- 💼 **持仓管理**：多用户独立持仓，支持股票/基金，自定义分组，SSE 自动刷新
- 💰 **收益计算**：实时显示持仓市值、累计收益、今日盈亏
- 🤖 **AI 投资顾问**：接入 Ollama（Qwen2.5:3b），结合持仓与历史行情给出流式投资建议
- 👤 **多用户账户**：注册/登录，JWT 认证，bcrypt 密码加密，全套安全防护
- 🔒 **隐私遮罩**：一键隐藏所有金融数据（总资产/收益等），偏好持久化
- 🎨 **现代 UI**：深色渐变背景，毛玻璃卡片，响应式设计

## 技术栈

| 层级 | 技术 |
|---|---|
| 后端 | Node.js + Express.js |
| 数据库 | MySQL（mysql2/promise）|
| 认证 | JWT（jsonwebtoken）+ bcrypt + HttpOnly Cookie |
| 前端 | Vue 3 + Vue Router 4（Vite 构建）|
| AI | Ollama（本地）+ Qwen2.5:3b |
| 行情数据 | 新浪财经 / 天天基金 |

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

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，填写 MySQL 连接信息和 JWT_SECRET
MYSQL_PASSWORD=你的MySQL密码
# 生成强随机密钥：node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=替换为64位以上随机字符串

# 3. 构建前端
pnpm run build

# 4. 启动服务
pnpm start

# 开发模式（热重启）
pnpm run dev
```

访问 [http://localhost:3000](http://localhost:3000)，注册账号后开始使用。

### 启用 AI 投资顾问

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
```

## 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口 |
| `NODE_ENV` | `production` | 运行环境 |
| `MYSQL_HOST` | `localhost` | MySQL 地址 |
| `MYSQL_PORT` | `3306` | MySQL 端口 |
| `MYSQL_USER` | `root` | MySQL 用户名 |
| `MYSQL_PASSWORD` | `` | MySQL 密码 |
| `MYSQL_DATABASE` | `astock` | 数据库名 |
| `JWT_SECRET` | *(必填)* | JWT 签名密钥，建议 64 位以上随机字符串 |
| `JWT_EXPIRES_IN` | `7d` | Token 有效期 |
| `SSE_INTERVAL_MS` | `10000` | SSE 推送间隔（毫秒） |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 服务地址 |
| `OLLAMA_MODEL` | `qwen2.5:3b` | 使用的 AI 模型（推荐 3b 轻量版，可换 7b 提升质量） |

## 项目结构

```
├── server.js                    # Express 服务入口
├── src/
│   ├── db/database.js           # MySQL 数据库层（users + positions）
│   ├── middleware/
│   │   └── auth.js              # JWT 认证中间件
│   ├── routes/
│   │   ├── auth.js              # 注册/登录/登出/me
│   │   ├── positions.js         # 持仓 CRUD + SSE 推送
│   │   ├── quote.js             # 行情代理 + 大盘 SSE
│   │   └── chat.js              # AI 聊天 SSE 路由
│   └── services/
│       ├── quoteService.js      # 行情数据服务
│       └── chatService.js       # Ollama 调用 + 上下文构建
├── client/src/
│   ├── pages/
│   │   ├── Home.vue             # 首页（持仓速览 + 大盘）
│   │   ├── Positions.vue        # 持仓管理
│   │   ├── AddPosition.vue      # 添加持仓
│   │   ├── Login.vue            # 登录/注册
│   │   └── Chat.vue             # AI 投资顾问
│   ├── components/
│   │   └── MarketIndex.vue      # 大盘指数组件
│   ├── composables/
│   │   └── usePrivacy.js        # 隐私遮罩全局状态
│   ├── api.js                   # 前端 API 封装
│   └── assets/style.css         # 全局样式（现代暗色风格）
└── Dockerfile
```

## API 说明

完整接口文档（请求参数、响应格式、限流规则、错误码等）详见：

📄 [docs/api.md](docs/api.md)

## 安全说明

- 密码使用 bcrypt（cost=12）哈希存储，从不明文传输
- JWT 存于 HttpOnly + SameSite=Strict Cookie，防 XSS 窃取
- 登录接口独立限流（5分钟/10次），超出锁定 15 分钟
- 所有持仓操作强制校验 `user_id`，防止越权访问
- helmet CSP 限制脚本/样式/字体来源，防注入攻击