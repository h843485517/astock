# 运行环境说明

本文档说明项目在**本地开发环境**与**生产环境**中各自的运行方式、架构差异及切换步骤。

---

## 本地开发环境

### 启动命令

```bash
npm run dev
```

`concurrently` 同时启动以下两个进程：

### 1. 后端服务（nodemon）

- 入口文件：`server.js`，运行于 `http://localhost:3000`
- 设置 `NODE_ENV=development`，**不启用 cluster 多核**，以单进程运行
- `nodemon` 监听源码变动，自动热重启
- MySQL 连接本地数据库（默认 `localhost:3306`）
- Ollama AI 服务地址 `http://localhost:11434`（**按需连接**：启动时不建立连接，仅当用户在 AI 投资顾问页面发送消息时，才实时发起请求；Ollama 不可达时返回错误提示，不影响持仓和行情功能）

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
npm run build   # Vite 构建前端静态资源到 dist/
npm start       # 先 build 再 node server.js
```

**方式二：Docker Compose 部署（推荐）**

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

`docker-compose.yml` 定义了四个服务：

| 容器 | 镜像 | 说明 |
|---|---|---|
| `astock-app` | 本地 Dockerfile 构建 | 主应用（Node.js + Express） |
| `astock-db` | `mysql:8.0` | MySQL 数据库，数据持久化到 volume |
| `astock-ollama` | `ollama/ollama` | AI 模型服务 |
| `astock-ollama-init` | `ollama/ollama` | 一次性任务，自动拉取 qwen2.5:3b 模型 |

容器间通过 Docker 服务名通信（而非 localhost）：

```
MYSQL_HOST=db
OLLAMA_BASE_URL=http://ollama:11434
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
| **数据库地址** | `localhost` | Docker 服务名 `db` |
| **Ollama 地址** | `http://localhost:11434` | `http://ollama:11434`（容器内） |

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
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama 服务地址 |
| `OLLAMA_MODEL` | `qwen2.5:3b` | 使用的 AI 模型 |

> 敏感变量（`JWT_SECRET`、`MYSQL_PASSWORD`）不应写入版本库，推荐通过系统环境变量或 CI/CD Secret 注入。

完整变量列表参见 [`.env.example`](../.env.example)。