# 部署方案指南

> 版本：v1.0 · 更新时间：2026-03-13

本项目为前后端同构部署架构：生产模式下 Node.js 直接托管 Vue 构建产物（`dist/`），前后端同端口、同域名提供服务。

---

## 前置准备

### 1. 构建前端

```bash
pnpm run build
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
| `OPENAI_API_KEY` | 免费 AI 模式 API Key（智谱 AI 注册免费获取）|

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
pnpm install --prod

# 构建前端
pnpm run build

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
# 构建镜像并启动所有服务
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