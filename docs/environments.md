# 运行环境说明

本文档说明项目在**本地开发环境**与**生产环境**中各自的运行方式、架构差异及切换步骤。

---

## 本地开发环境

### 启动命令

```bash
pnpm run dev
```

`concurrently` 同时启动以下两个进程：

### 1. 后端服务（nodemon）

- 入口文件：`server.js`，运行于 `http://localhost:3000`
- 设置 `NODE_ENV=development`，**不启用 cluster 多核**，以单进程运行
- `nodemon` 监听源码变动，自动热重启
- MySQL 连接本地数据库（默认 `localhost:3306`）
- AI 投资顾问默认走**免费模式**（OpenAI 兼容 API，如智谱 AI），仅当用户在 Chat 页面发送消息时才实时请求；VIP 用户走本地 Ollama（`http://localhost:11434`），两者均不影响持仓和行情功能

### 2. 前端开发服务器（Vite）

- 运行于 `http://localhost:5173`
- 支持 **HMR（热模块替换）**，Vue 单文件组件实时编译
- 所有 `/api` 请求通过代理转发至 `http://localhost:3000`，无跨域问题
- 静态资源在内存中构建，无需生成 `dist/` 目录

> 开发时访问入口为 `http://localhost:5173`

**代理机制说明**：浏览器发起的 `/api/*` 请求会被 Vite 拦截并转发至后端（`:3000`），对浏览器而言请求的是同源地址（`:5173`），避免跨域问题。生产环境下前后端同端口部署，无需代理配置。

---

## 生产环境

### 启动方式

**方式一：直接运行**

```bash
pnpm run build   # Vite 构建前端静态资源到 dist/
pnpm start       # node server.js（生产模式，自动启用 cluster）
```

**方式二：Docker Compose 部署（推荐，适合 ECS）**

```bash
cp .env.example .env        # 配置环境变量
export JWT_SECRET=$(openssl rand -hex 64)
export MYSQL_PASSWORD=your_strong_password
docker-compose up -d
```

### 运行架构

#### Node.js Cluster 多进程模式

- **主进程（Primary）**：读取 CPU 核心数，fork 等量 Worker 进程后退出 HTTP 逻辑
- **Worker 进程**：每个核心一个，各自监听同一端口，由操作系统负载均衡
- Worker 崩溃时，主进程自动重新 fork，保证服务不中断

#### 静态文件服务

- 前端资源预构建至 `dist/` 目录
- Express 直接托管 `dist/` 静态文件
- 所有非 `/api` 路由统一返回 `dist/index.html`，支持 Vue Router SPA 路由

#### 性能与安全配置

| 配置项 | 默认值 | 说明 |
|---|---|---|
| Gzip 压缩 | 启用 | SSE 流式路由跳过，避免缓冲 |
| API 限流 | 300次/15分钟/IP | 超出返回 429 |
| 登录限流 | 10次/5分钟/IP | 超出锁定 15 分钟 |
| 请求体限制 | 100KB | 防超大请求攻击 |
| Helmet CSP | 启用 | 限制脚本/样式/字体来源 |

### Docker Compose 容器编排

`docker-compose.yml` 当前针对 ECS 环境优化，仅包含一个必需服务：

| 容器 | 镜像 | 说明 |
|---|---|---|
| `astock-app` | 本地 Dockerfile 构建 | 主应用（Node.js + Express） |

> **已注释的可选服务：**
> - `astock-db`：MySQL 容器，ECS 有自带 MySQL 时无需启用，直接通过 `172.17.0.1`（Docker 桥接网关）访问宿主机数据库
> - `astock-ollama` + `astock-ollama-init`：Ollama 容器，仅 VIP 模式需要且服务器内存 ≥ 8GB 时启用；普通用户默认走免费云端 API，无需此服务

容器间通过 Docker 服务名通信（启用 Ollama 时）：

```
MYSQL_HOST=172.17.0.1        # 访问宿主机 MySQL
OLLAMA_BASE_URL=http://ollama:11434  # 容器内访问 Ollama
```

**Dockerfile 采用多阶段构建：**

1. **builder 阶段**：基于 `node:20-alpine`，安装全量依赖并执行 `vite build`
2. **runtime 阶段**：仅复制 `dist/`、`src/`、`server.js`，安装生产依赖，镜像体积最小化

---

## 核心差异对比

| 特性 | 本地开发 | 生产环境 |
|---|---|---|
| **启动命令** | `npm run dev` | `npm start` 或 `docker-compose up -d` |
| **进程模式** | 单进程 | Cluster 多进程（CPU 核数） |
| **前端服务** | Vite 开发服务器（端口 5173） | Express 托管 `dist/` 静态文件 |
| **热更新** | 后端 nodemon + 前端 HMR | 无，需重新构建部署 |
| **访问入口** | `http://localhost:5173` | `http://localhost:3000` |
| **构建产物** | 无需构建 | 需预先执行 `vite build` |
| **NODE_ENV** | `development` | `production` |
| **数据库地址** | `localhost` | Docker 桥接网关 `172.17.0.1`（宿主机 MySQL）|
| **AI 模式** | 免费模式（云端 API）/ VIP 模式（本地 Ollama）| 同左，容器内 Ollama 地址改为 `http://ollama:11434` |

---

## 环境变量配置

复制 `.env.example` 为 `.env` 后按需修改，以下为关键变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | 服务监听端口 |
| `NODE_ENV` | `production` | 运行环境 |
| `JWT_SECRET` | *(必填)* | JWT 签名密钥，建议 64 位随机字符串 |
| `MYSQL_HOST` | `localhost` | MySQL 地址 |
| `MYSQL_PASSWORD` | *(必填)* | MySQL 密码 |
| `SSE_INTERVAL_MS` | `10000` | SSE 推送间隔（毫秒） |
| `OPENAI_API_BASE` | `https://open.bigmodel.cn/api/paas/v4` | 免费模式 AI 接口地址（智谱 AI）|
| `OPENAI_API_KEY` | *(必填，免费 AI 可用)* | 免费模式 API Key |
| `OPENAI_FREE_MODEL` | `GLM-4-Flash-250414` | 免费模式使用的模型名称 |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | VIP 模式 Ollama 服务地址 |
| `OLLAMA_MODEL` | `qwen2.5:3b` | VIP 模式使用的 AI 模型 |

> 敏感变量（`JWT_SECRET`、`MYSQL_PASSWORD`）不应写入版本库，推荐通过系统环境变量或 CI/CD Secret 注入。
>
> AI 双模式说明：所有新用户默认走**免费模式**（云端 OpenAI 兼容 API），执行 `node scripts/test-ai.js set-vip <用户名>` 后升级为 **VIP 模式**（本地 Ollama）。

完整变量列表参见 [`.env.example`](../.env.example)。