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

## 阿里云部署完整指南（ECS + MySql + Nginx）

> 推荐配置：ECS（2核4G，Ubuntu 22.04）+ RDS MySQL 8.0 + 域名 + SSL 证书

### 第一步：购买并初始化 ECS

1. 登录[阿里云控制台](https://ecs.console.aliyun.com)，购买 ECS 实例
   - 操作系统选择 **Ubuntu 22.04 LTS 64位**
   - 安全组放通端口：`22`（SSH）、`80`（HTTP）、`443`（HTTPS）
   - 建议同时购买**弹性公网 IP** 并绑定到实例

2. SSH 登录 ECS：
   ```bash
   ssh root@<你的公网IP>
   ```

3. 初始化服务器环境：
   ```bash
   apt update && apt upgrade -y
   # 安装 Node.js 20
   curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
   apt install -y nodejs git nginx
   # 启用 corepack 并安装 pnpm
   corepack enable && corepack prepare pnpm@latest --activate
   # 安装 PM2
   npm install -g pm2
   ```

---

### 第二步：将本地代码上传到 ECS

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

### 第三步：在 ECS 上安装 MySQL

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
```

> ⚠️ 阿里云安全组**无需**开放 3306 端口，MySQL 只在本机内部访问，安全性更高。

---

### 第四步：部署应用代码

```bash
cd /opt/astock

# 安装依赖（仅生产依赖）
pnpm install --prod

# 配置环境变量
cp .env.example .env
```

编辑 `.env`，填入以下关键配置：

```ini
NODE_ENV=production
PORT=3000

# MySQL 本机部署，直接用 localhost
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=astock_user
MYSQL_PASSWORD=你的强密码
MYSQL_DATABASE=astock

# 生成强随机密钥：node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
JWT_SECRET=替换为64位以上随机字符串
```

```bash
# 构建前端
pnpm run build

# 用 PM2 启动并设置开机自启
pm2 start server.js --name astock
pm2 save
pm2 startup   # 按提示执行输出的命令
```

---

### 第五步：安装 Ollama（可选，启用 AI 投资顾问）

> **资源要求**：qwen2.5:3b 模型推理需约 4~5GB 内存，建议 ECS 内存 **≥ 8G**。2核4G 机器不建议开启，CPU 推理单次响应可能需要 30~120 秒。

若无需 AI 投资顾问功能，跳过此步骤，持仓和行情功能不受影响。

```bash
# 安装 Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# 设置开机自启并立即启动
systemctl enable ollama
systemctl start ollama

# 拉取推荐模型（约 1.9GB，中文能力强且轻量）
ollama pull qwen2.5:3b

# 验证服务是否正常
curl http://localhost:11434/api/tags
```

Ollama 默认监听 `http://localhost:11434`，与 `.env` 中的 `OLLAMA_BASE_URL` 默认值一致，**无需修改任何配置**。

> ⚠️ Ollama 仅监听本机，阿里云安全组**无需**开放 11434 端口。

---

### 第六步：配置 Nginx + HTTPS

1. **申请 SSL 证书**：阿里云控制台 → **数字证书管理** → 免费申请 DV 证书（有效期 1 年），下载 **Nginx** 格式的证书文件（`xxx.pem` + `xxx.key`），上传到 ECS `/etc/ssl/astock/`

2. **配置 Nginx**：

   ```bash
   vim /etc/nginx/sites-available/astock
   ```

   写入以下内容（替换域名和证书路径）：

   ```nginx
   # HTTP → HTTPS 跳转
   server {
       listen 80;
       server_name your-domain.com;
       return 301 https://$host$request_uri;
   }

   server {
       listen 443 ssl;
       server_name your-domain.com;

       ssl_certificate     /etc/ssl/astock/xxx.pem;
       ssl_certificate_key /etc/ssl/astock/xxx.key;
       ssl_protocols       TLSv1.2 TLSv1.3;

       # 静态资源缓存（长期缓存带哈希的 JS/CSS）
       location ~* \.(js|css|png|jpg|svg|ico|woff2)$ {
           root /opt/astock/dist;
           expires 30d;
           add_header Cache-Control "public, immutable";
       }

       # SSE 接口：禁止缓冲，保障实时推送
       location ~ ^/api/(market-index/stream|positions/stream|chat/stream) {
           proxy_pass http://127.0.0.1:3000;
           proxy_buffering         off;
           proxy_cache             off;
           proxy_set_header        Connection '';
           proxy_http_version      1.1;
           chunked_transfer_encoding on;
           proxy_set_header        Host $host;
           proxy_set_header        X-Real-IP $remote_addr;
       }

       # 普通 API 反代
       location /api/ {
           proxy_pass http://127.0.0.1:3000;
           proxy_set_header Host              $host;
           proxy_set_header X-Real-IP         $remote_addr;
           proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }

       # SPA 路由兜底
       location / {
           root /opt/astock/dist;
           try_files $uri $uri/ /index.html;
       }
   }
   ```

3. **启用并重载 Nginx**：

   ```bash
   ln -s /etc/nginx/sites-available/astock /etc/nginx/sites-enabled/
   nginx -t          # 校验配置
   systemctl reload nginx
   ```

4. 将域名 **A 记录**解析到 ECS 公网 IP（阿里云云解析 DNS 控制台操作）。

---

### 第七步：后续更新代码

**方式一（Git）：**
```bash
cd /opt/astock
git pull
pnpm install --prod
pnpm run build
pm2 restart astock
```

**方式二（scp）：** 重新在本地打包，执行第二步的 `tar + scp` 命令上传，解压后重跑 `pnpm install --prod && pnpm run build && pm2 restart astock`。

---

### 阿里云资源总费用参考

| 资源 | 规格 | 参考月费 |
|------|------|---------|
| ECS | 2核4G，按量付费 | ¥100~200/月 |
| MySQL（ECS 自建） | 装在 ECS 上，无额外费用 | 免费 |
| 公网 IP | 按流量计费 | ¥5~30/月 |
| SSL 证书 | DV 免费证书 | 免费 |
| 域名 | .com | ¥50~80/年 |

> 个人项目可选择更小规格（ECS 1核2G + RDS 最小规格）进一步降低费用。

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