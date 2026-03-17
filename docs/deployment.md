# 部署方案指南

> 版本：v1.0 · 更新时间：2026-03-13

本项目为前后端同构部署架构：生产模式下 Node.js 直接托管 Vue 构建产物（`dist/`），前后端同端口、同域名提供服务。

---

## 前置准备

### 1. 构建前端

```bash
npm run build
```

产物输出至 `dist/`，Node.js 启动后自动将其作为静态文件服务。

### 2. 配置环境变量

复制并按需修改：

```bash
cp .env.example .env
```

**生产环境必须配置的变量：**

| 变量名 | 说明 |
|--------|------|
| `NODE_ENV` | 设为 `production` |
| `JWT_SECRET` | 强随机字符串，用于 JWT 签名（**不可泄露**）|
| `MYSQL_HOST` | MySQL 主机地址 |
| `MYSQL_USER` | MySQL 用户名 |
| `MYSQL_PASSWORD` | MySQL 密码 |
| `MYSQL_DATABASE` | 数据库名，默认 `astock` |

其余变量参见 `.env.example` 注释。

---

## 方案 A：单机直接部署（最简）

**适合场景**：个人项目、内网使用、低流量场景。

```
[用户] → Node.js :3000 → MySQL
```

### 启动步骤

```bash
# 安装依赖
npm install --omit=dev

# 构建前端
npm run build

# 启动（生产模式自动 cluster 多核）
NODE_ENV=production node server.js
```

### 说明

- 生产模式下自动按 CPU 核数 fork worker 进程，单进程崩溃后自动重启。
- 建议配合 **PM2** 实现进程守护和日志管理：

```bash
npm install -g pm2
pm2 start server.js --name astock --env production
pm2 save && pm2 startup
```

---

## 方案 B：Nginx 反向代理 + Node.js（推荐生产）

**适合场景**：有公网服务器的正式上线，需要 HTTPS、静态资源缓存。

```
[用户] → Nginx :443/80
           ├── /api/*        → 反代 Node.js :3000
           └── 其余路径       → 直接读 dist/ 静态文件 或 反代 Node.js
```

### Nginx 配置要点

```nginx
server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    # 静态文件缓存
    location ~* \.(js|css|png|jpg|svg|ico|woff2)$ {
        root /path/to/project/dist;
        expires 30d;
        add_header Cache-Control "public, immutable";
    }

    # API 反代
    location /api/ {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # SSE 专项配置（禁止 Nginx 缓冲，防止数据积压）
    location ~ ^/api/(market-index/stream|positions/stream|chat/stream) {
        proxy_pass http://127.0.0.1:3000;
        proxy_buffering off;
        proxy_cache off;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding on;
    }

    # SPA 兜底
    location / {
        root /path/to/project/dist;
        try_files $uri $uri/ /index.html;
    }
}
```

> ⚠️ SSE 路由（`/api/*/stream`）**必须**配置 `proxy_buffering off`，否则实时推送数据会被 Nginx 缓冲延迟。

### SSL 证书（Let's Encrypt）

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d your-domain.com
```

---

## 方案 C：Docker Compose 容器化（开箱即用）

**适合场景**：快速交付、CI/CD 流水线、多机器迁移、环境隔离。

项目已内置 `Dockerfile` 与 `docker-compose.yml`，直接启动：

```bash
# 构建镜像并启动所有服务（Node.js + MySQL）
docker-compose up -d --build

# 查看日志
docker-compose logs -f app
```

### 生产环境覆盖配置

创建 `docker-compose.prod.yml` 设置生产环境变量：

```yaml
version: '3.8'
services:
  app:
    environment:
      - NODE_ENV=production
      - JWT_SECRET=your-strong-secret
      - MYSQL_PASSWORD=your-db-password
```

```bash
docker-compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

### 与 Nginx 叠加

可在 compose 中增加 Nginx 容器处理 SSL 和静态缓存，Node.js 容器只暴露内部端口，不对外开放。

---

## 方案 D：云平台 PaaS 部署

**适合场景**：无运维经验、希望托管数据库、快速上线。

| 平台 | 说明 | MySQL 支持 |
|------|------|-----------|
| **Railway** | 连接 GitHub 自动构建部署，支持 MySQL 插件 | ✅ 内置插件 |
| **Render** | 免费套餐可用，支持 Node.js + MySQL 托管 | ✅ 托管数据库 |
| **阿里云 ECS + RDS** | Node.js 部署在 ECS，MySQL 使用 RDS，生产级稳定性 | ✅ RDS 托管 |
| **腾讯云 CVM + TDSQL** | 同上，国内延迟更低 | ✅ 托管 |

> 纯前端平台（如 Vercel、Netlify）不适合本项目，需要将 API 服务与前端分开托管，改造成本较高。

---

## 阿里云部署完整指南（ECS + Docker Compose）

> 推荐配置：ECS（2核4G，Ubuntu 22.04），已安装 Docker。项目自带 `docker-compose.yml`，MySQL、Ollama、应用全部容器化，无需手动安装任何服务。

### 第一步：购买并初始化 ECS

1. 登录[阿里云控制台](https://ecs.console.aliyun.com)，购买 ECS 实例
   - 操作系统选择 **Ubuntu 22.04 LTS 64位**
   - 安全组放通端口：`22`（SSH）、`3000`（应用端口）
   - 建议同时购买**弹性公网 IP** 并绑定到实例

2. SSH 登录 ECS：
   ```bash
   ssh root@<你的公网IP>
   ```

3. 确认 Docker 已安装并运行：
   ```bash
   docker --version
   docker compose version
   ```
   若未安装，执行：
   ```bash
   curl -fsSL https://get.docker.com | sh
   systemctl enable docker && systemctl start docker
   ```

---

### 第二步：安装运行环境（Node.js、pnpm、MySQL）

> 若使用 Docker Compose 方案（即后续第四步），Node.js 和 MySQL 均由容器提供，**可跳过本步骤**。若选择直接在宿主机运行（方案 A/B），则需手动安装。

#### 安装 Node.js 20 + pnpm

```bash
# 通过 NodeSource 安装 Node.js 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# 验证版本
node -v   # 应输出 v20.x.x
npm -v

# 安装 pnpm
npm install -g pnpm
pnpm -v
```

#### 安装 MySQL 8.0

```bash
# 安装 MySQL 8.0
apt install -y mysql-server

# 启动并设置开机自启
systemctl start mysql
systemctl enable mysql

# 初始化安全配置（设置 root 密码、移除匿名账号等）
mysql_secure_installation
```

登录 MySQL，创建专用数据库和账号（**不要直接用 root**）：

```sql
mysql -u root -p

-- 创建数据库
CREATE DATABASE astock CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 创建专用账号，仅允许本机登录
CREATE USER 'astock_user'@'localhost' IDENTIFIED BY '你的强密码';
GRANT ALL PRIVILEGES ON astock.* TO 'astock_user'@'localhost';
FLUSH PRIVILEGES;
EXIT;

-- 清空数据库的表
-- 第一步
mysql -u astock_user -p

-- 第二步fatal: unable to access 'https://github.com/h843485517/astock.git/': Failed to connect to github.com port 443 after 129461 ms: Connection timed out
USE astock;
SET FOREIGN_KEY_CHECKS = 0;
TRUNCATE TABLE users;
TRUNCATE TABLE positions;
TRUNCATE TABLE daily_snapshots;
SET FOREIGN_KEY_CHECKS = 1;
EXIT;
```

完成后在 `.env` 中填写对应配置：

```ini
MYSQL_HOST=127.0.0.1
MYSQL_USER=astock_user
MYSQL_PASSWORD=你的强密码
MYSQL_DATABASE=astock
```

---

### 第三步：将本地代码上传到 ECS

本地代码需要先送到 ECS，有两种方式，**二选一**即可。

#### 方式一：推送到 GitHub / Gitee（推荐，便于后续持续更新）

在本地项目根目录执行：

```bash
git init
git remote add origin https://gitee.com/你的用户名/astock.git  # 国内推荐 Gitee，速度更稳
git add .
git commit -m "init"
git push -u origin main
```

在 ECS 上克隆：

```bash
git clone https://gitee.com/你的用户名/astock.git /opt/astock
```

后续每次本地更新后，在 ECS 执行 `git pull` 即可同步。

#### 方式二：scp 直接传输（无需 Git 仓库，适合一次性部署）

在本地执行（自动排除 `node_modules`、`dist`、`.env`）：

```bash
tar --exclude=node_modules --exclude=dist --exclude=.env \
    -czf astock.tar.gz .
scp astock.tar.gz root@<你的ECS公网IP>:/opt/
```

登录 ECS 后解压：

```bash
mkdir -p /opt/astock
tar -xzf /opt/astock.tar.gz -C /opt/astock
```

> 方式二不带版本管理，后续更新需重复打包上传，长期维护建议切换到方式一。

---

### 第四步：配置环境变量

```bash
cd /opt/astock
cp .env.example .env
```

编辑 `.env`，填入以下关键配置（其余保持默认即可）：

```ini

# MySQL 容器内通信，HOST 固定填 db（docker-compose 服务名）
MYSQL_USER=astock_user
MYSQL_PASSWORD=你的强密码
# 生成强随机密钥：openssl rand -hex 64
JWT_SECRET=替换为64位以上随机字符串
```

> ⚠️ `MYSQL_PASSWORD` 和 `JWT_SECRET` 不要使用简单字符串，生产环境务必设置强密码/密钥。

---

### 第五步：启动所有服务

```bash
cd /opt/astock
docker compose up -d --build
```

此命令会自动完成：
- 构建应用镜像（含前端 Vite 编译）
- 启动 MySQL 8.0 容器，数据持久化到 Docker volume
- 启动 Ollama 容器，并自动拉取 qwen2.5:3b 模型（首次约需几分钟，需 ECS 内存 ≥ 8G）
- 启动应用容器，等待 MySQL 健康检查通过后自动连接

查看启动状态：

```bash
docker compose ps           # 查看各容器运行状态
docker compose logs -f app  # 实时查看应用日志
docker compose logs app --tail=50 # 如果日志太长，只看最后 50 行
```

启动成功后访问 `http://<你的公网IP>:3000`。

> 若无需 AI 投资顾问功能，可在 `docker-compose.yml` 中注释掉 `ollama` 和 `ollama-init` 服务，节省内存。

---

### 附：单独启动 Ollama（不使用 Docker）

如果 ECS 内存 ≥ 8G，也可以在宿主机上直接运行 Ollama，不依赖 Docker 容器：

```bash
# 1. 安装 Ollama（Linux）
curl -fsSL https://ollama.com/install.sh | sh

# 2. 启动 Ollama 服务（监听所有接口，供容器内的 app 访问）
OLLAMA_HOST=0.0.0.0 ollama serve &

# 3. 拉取推荐模型（首次约需几分钟，模型约 2GB）
ollama pull qwen2.5:3b
```

启动后，在 `.env` 中将 Ollama 地址指向宿主机：

```ini
OLLAMA_BASE_URL=http://172.17.0.1:11434   # Docker 默认网桥网关地址
```

> ⚠️ `172.17.0.1` 为 Docker bridge 网关，容器内可通过此地址访问宿主机上的服务。也可用 `host.docker.internal`（需 Docker 20.10+）。

用 systemd 实现开机自启：

```bash
systemctl enable ollama
systemctl start ollama
```

#### ECS 内存不足时的替代方案

> ⚠️ 以下「换用小模型」和「量化版模型」方案仍需将 Ollama **安装在 ECS 上**，只是减少内存占用。若 ECS 内存实在不足，推荐使用后两种**完全不在 ECS 安装 Ollama** 的方案。

| 方案 | 是否需要装在 ECS | 适合场景 | 说明 |
|------|----------------|---------|------|
| **换用更小的模型** | ✅ 需要 | ECS 内存 4~6G | 用 `qwen2.5:0.5b`（~500MB）或 `qwen2.5:1.5b`（~1.5GB）替代默认的 `qwen2.5:3b` |
| **使用量化版模型** | ✅ 需要 | ECS 内存 4G | 拉取 Q4 量化版：`ollama pull qwen2.5:3b-instruct-q4_K_M`，内存降至约 2GB |
| **本地电脑运行 Ollama** | ❌ 不需要 | ECS 内存不足，本地有空闲机器 | 在本地 Mac/Windows 运行 Ollama，将 `.env` 中 `OLLAMA_BASE_URL` 改为本地公网 IP |
| **接入云端 LLM API** | ❌ 不需要 | 不想自托管任何模型 | 改接 DeepSeek / 通义千问等兼容 OpenAI 格式的 API，按 token 计费，无需任何本地资源 |

**方案一：换用小模型（仍在 ECS 安装，降低内存占用）**

```bash
ollama pull qwen2.5:0.5b

# .env 中指定模型名
OLLAMA_MODEL=qwen2.5:0.5b
```

**方案二：本地电脑运行 Ollama，ECS 零内存占用**

在本地机器（Mac/Windows/Linux）上启动 Ollama：

```bash
# macOS 示例
brew install ollama
OLLAMA_HOST=0.0.0.0 ollama serve &
ollama pull qwen2.5:3b
```

然后在 ECS 的 `.env` 中配置本地公网 IP：

```ini
OLLAMA_BASE_URL=http://<本地公网IP>:11434
```

> ⚠️ 需确保本地路由器将 11434 端口转发到运行 Ollama 的机器，并在防火墙放行该端口。

**方案三：接入云端 API（推荐，最省心）**

以 DeepSeek 为例，其 API 兼容 OpenAI 格式，修改 `src/services/chatService.js` 中的 baseURL 和 model 即可：

```ini
# .env 中配置
OLLAMA_BASE_URL=https://api.deepseek.com/v1
OLLAMA_MODEL=deepseek-chat
OLLAMA_API_KEY=你的DeepSeek API Key
```

> 云端 API 按 token 计费，无需在任何服务器上安装模型，适合 ECS 内存紧张的场景。

---

### 第六步：后续更新代码

**方式一（Git）：**
```bash
cd /opt/astock
git pull
docker compose up -d --build app   # 仅重建应用容器，不影响数据库和 Ollama
```

**方式二（scp）：** 重新打包上传，解压后重跑 `docker compose up -d --build app`。

---

### 阿里云资源总费用参考

| 资源 | 规格 | 参考月费 |
|------|------|---------|
| ECS | 2核4G，按量付费 | ¥100~200/月 |
| MySQL（Docker 容器） | 运行在 ECS 上，无额外费用 | 免费 |
| 公网 IP | 按流量计费 | ¥5~30/月 |
| 域名 | .com（可选） | ¥50~80/年 |

> Ollama 需要约 4~5GB 内存，2核4G 机器建议关闭 Ollama 容器，持仓和行情功能不受影响。

---

## 方案对比

| | 方案 A 单机直接 | 方案 B Nginx 反代 | 方案 C Docker | 方案 D PaaS |
|---|---|---|---|---|
| 配置复杂度 | ⭐ 最简 | ⭐⭐⭐ 中等 | ⭐⭐ 简单 | ⭐ 最简 |
| HTTPS 支持 | ❌ 需额外配置 | ✅ | ✅ 需额外配置 | ✅ 自动 |
| 静态资源缓存 | ❌ | ✅ | ✅ 配合 Nginx | ✅ CDN |
| 多核利用 | ✅ cluster | ✅ | ✅ | ✅ |
| 环境隔离 | ❌ | ❌ | ✅ | ✅ |
| 推荐指数 | 🔧 开发/测试 | 🚀 **正式生产** | 🐳 **CI/CD** | ☁️ 快速交付 |

**推荐组合**：正式生产环境优先选择 **方案 B（Nginx + Node.js + PM2）** 或 **方案 C（Docker Compose + Nginx 容器）**，两者可叠加使用。