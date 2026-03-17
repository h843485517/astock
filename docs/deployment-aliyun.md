# 阿里云 ECS 部署指南

> 版本：v1.0 · 更新时间：2026-03-17  
> 推荐配置：ECS（2核4G，Ubuntu 22.04），已安装 Docker 和 MySQL。  
> 应用通过 Docker Compose 容器化部署，MySQL 使用 ECS 宿主机服务，无需手动安装 Node.js。

---

## 第一步：购买并初始化 ECS

1. 登录 [阿里云控制台](https://ecs.console.aliyun.com)，购买 ECS 实例
   - 操作系统选择 **Ubuntu 22.04 LTS 64位**
   - 安全组放通端口：`22`（SSH）、`3000`（应用端口）
   - 建议同时购买**弹性公网 IP** 并绑定到实例

2. SSH 登录 ECS：
   ```bash
   ssh root@<你的公网IP>
   ```

3. 安装 Docker（若未预装）：
   ```bash
   curl -fsSL https://get.docker.com | sh
   systemctl enable docker && systemctl start docker
   # 验证
   docker --version
   docker compose version
   ```

---

## 第二步：安装 MySQL 8.0

> 项目的 `docker-compose.yml` 中 MySQL 容器默认已注释，使用 ECS 宿主机 MySQL，应用通过 Docker 桥接网关 `172.17.0.1` 访问。

```bash
# 安装 MySQL 8.0
apt install -y mysql-server

# 启动并设置开机自启
systemctl start mysql
systemctl enable mysql

# 初始化安全配置（设置 root 密码、移除匿名账号等）
mysql_secure_installation
```

创建专用数据库和账号（**不要直接用 root**）：

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

> ⚠️ 首次启动应用时会**自动创建所有表结构**，无需手动执行建表 SQL。

---

## 第三步：将代码上传到 ECS

二选一即可。

### 方式一：Git 推送（推荐，便于持续更新）

本地执行：

```bash
git init
git remote add origin https://gitee.com/你的用户名/astock.git  # 国内推荐 Gitee
git add .
git commit -m "init"
git push -u origin main
```

ECS 上克隆：

```bash
git clone https://gitee.com/你的用户名/astock.git /opt/astock
```

后续每次本地更新，ECS 执行 `git pull` 即可同步。

### 方式二：scp 直接传输（无需 Git）

本地打包（自动排除 `node_modules`、`dist`、`.env`）：

```bash
tar --exclude=node_modules --exclude=dist --exclude=.env \
    -czf astock.tar.gz .
scp astock.tar.gz root@<你的ECS公网IP>:/opt/
```

ECS 上解压：

```bash
mkdir -p /opt/astock
tar -xzf /opt/astock.tar.gz -C /opt/astock
```

---

## 第四步：配置环境变量

```bash
cd /opt/astock
cp .env.example .env
```

编辑 `.env`，填入以下关键配置（其余保持默认）：

```ini
# ─── 数据库 ──────────────────────────────────────────────────
# 容器内通过 Docker 桥接网关访问宿主机 MySQL
MYSQL_HOST=172.17.0.1
MYSQL_USER=astock_user
MYSQL_PASSWORD=你的强密码
MYSQL_DATABASE=astock

# ─── JWT ─────────────────────────────────────────────────────
# 生成命令：openssl rand -hex 64
JWT_SECRET=替换为64位以上随机字符串

# ─── AI 免费模式（推荐，GLM-4-Flash 永久免费）────────────────
OPENAI_API_BASE=https://open.bigmodel.cn/api/paas/v4
OPENAI_API_KEY=你的智谱APIKey    # 注册：https://open.bigmodel.cn
OPENAI_FREE_MODEL=GLM-4-Flash-250414
```

> ⚠️ `MYSQL_PASSWORD` 和 `JWT_SECRET` 务必设置强密码/密钥，不要使用简单字符串。

---

## 第五步：启动应用

```bash
cd /opt/astock
docker compose up -d --build
```

此命令会自动完成：
- 构建应用镜像（含前端 Vite 编译，约需 1~2 分钟）
- 启动应用容器，通过 `172.17.0.1` 连接宿主机 MySQL
- 首次启动自动初始化所有数据库表结构

查看运行状态：

```bash
docker compose ps                  # 查看容器状态
docker compose logs -f app         # 实时查看日志
docker compose logs app --tail=50  # 只看最后 50 行
```

启动成功后访问：`http://<你的公网IP>:3000`

---

## 第六步：后续更新代码

### Git 方式

```bash
cd /opt/astock
git pull
docker compose up -d --build app  # 仅重建应用容器，不影响数据库
```

### scp 方式

重新打包上传解压后，执行 `docker compose up -d --build app`。

---

## 附：启用 VIP 模式（Ollama 本地 AI）

> 普通用户默认使用免费云端 AI（智谱 AI），**ECS 2核4G 无需安装 Ollama**。  
> 仅当需要为指定用户开启 VIP 本地模型时才参考此节，且建议 ECS 内存 ≥ 8GB。

### 安装并启动 Ollama

```bash
# 安装
curl -fsSL https://ollama.com/install.sh | sh

# 监听所有接口（供 Docker 容器内访问）
OLLAMA_HOST=0.0.0.0 ollama serve &

# 拉取推荐模型（约 2GB，首次需几分钟）
ollama pull qwen2.5:3b

# 开机自启
systemctl enable ollama
```

在 `.env` 中指向宿主机 Ollama：

```ini
OLLAMA_BASE_URL=http://172.17.0.1:11434
OLLAMA_MODEL=qwen2.5:3b
```
docker部署问题

基本指令

```js
cd /opt/astock
docker compose down // 关闭容器
docker compose up -d // 重启
docker compose logs app --tail=20 // 日志
```


# docker-compose常见问题
## MYSQL_HOST
### 不能用`localhost` 而应该用 「宿主机实际IP」
因为在 Docker 容器内，`localhost` 指的是**容器自己**，而不是宿主机。我的 MySQL 运行在 ECS 宿主机上，容器需要通过宿主机 IP 才能访问。

```js
// 使用 ECS 自带 MySQL，通过 Docker 桥接网关访问宿主机。
MYSQL_HOST: 172.17.0.1
```
**通常是 **`172.17.0.1`，但如果 Docker 配置过自定义网络，可能不同。如果 `172.17.0.1` 连不上 MySQL，也可以用宿主机的实际内网 IP

```js
ip addr show docker0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 // 查看 Docker 桥接网关地址
ip addr show eth0 | grep 'inet ' | awk '{print $2}' | cut -d/ -f1 // 查看宿主机内网 IP
```


### MySQL 未监听在允许 Docker 容器访问的地址上
在 ECS 上执行以下命令查看 Docker 桥接网关地址：

```js
# 1. 检查 MySQL 是否在运行
systemctl status mysql

# 2. 检查 MySQL 监听地址（应该是 0.0.0.0 或 *，而不是 127.0.0.1）
netstat -tuln | grep 3306

# 3. 检查 MySQL bind-address 配置
grep bind-address /etc/mysql/mysql.conf.d/mysqld.cnf
```
**如果看到 **`bind-address = 127.0.0.1`**，需要改成 **`0.0.0.0`**：**

```js
# 编辑配置文件
sudo vim /etc/mysql/mysql.conf.d/mysqld.cnf

# 找到这行：
# bind-address = 127.0.0.1
# 改为：
bind-address = 0.0.0.0

# 重启 MySQL
sudo systemctl restart mysql

# 验证监听地址
netstat -tuln | grep 3306
```
改完后重新启动容器：

```js
docker compose down
docker compose up -d
docker compose logs app --tail=20
```
### **MySQL 用户权限允许从Docker网段进行TCP连接**
**需要给 Docker 网段授权：**

```js
mysql -u root -p
```
```js
-- 为 Docker 网段创建用户（或授权现有用户）
CREATE USER 'astock_user'@'172.17.%' IDENTIFIED BY '你的强密码';
GRANT ALL PRIVILEGES ON astock.* TO 'astock_user'@'172.17.%';
FLUSH PRIVILEGES;

-- 验证用户列表
SELECT user, host FROM mysql.user WHERE user='astock_user';
EXIT;
```
> 这儿的Docker网段是自动分配的，如果日志中报错了，可以查看网段是多少，换成正确的网段即可
然后重启容器：

```js
docker compose down
docker compose up -d
docker compose logs app --tail=20
```


可能会出现网段信息报错，报错信息如下：

```js
❌ 数据库初始化失败: Host '172.18.0.2' is not allowed to connect to this MySQL server
```
那就证明网段设置应该是`172.18.%`

```js
-- 为 172.18 网段授权
CREATE USER 'astock_user'@'172.18.%' IDENTIFIED BY '19971121Hjh!';
GRANT ALL PRIVILEGES ON astock.* TO 'astock_user'@'172.18.%';
FLUSH PRIVILEGES;

-- 查看授权结果
SELECT user, host FROM mysql.user WHERE user='astock_user';
EXIT;
```
## 未正确设置PORT
```js
ports:
  - "${PORT:-3000}:${PORT:-3000}"
  
environment：
    PORT: ${PORT:-3000}
```
 （1）端口映射（一次修改，终身生效）

* 格式：`宿主机端口:容器端口`
* `${PORT:-3000}` 读取 `.env` 中的 `PORT`，如果没有就用 3000
* 例如 `.env` 中 `PORT=3009`，这行就是 `3009:3009`。意思：ECS 宿主机的 3009 端口映射到容器内的 3009 端口

（2）只用在.env文件中增加逻辑即可，注入端口环境变量

```js
PORT=3009
```
* 把 `.env` 的 `PORT` 值注入到容器内部
* `server.js` 中读取 `process.env.PORT`，决定 **Node.js 监听哪个容器端口**



**为什么要同步？**

* 如果只改端口映射为 `3009:3000`，宿主机 3009 会映射到容器 3000
* 但容器内 Node.js 实际监听的是 3009（从环境变量读取）
* 结果：映射到 3000 没人监听，访问失败

**两者必须一致**才能保证：外部访问 → 端口映射 → Node.js 监听 完整链路通畅。



# docker启动成功后，页面报错
## 页面资源未加载
容器已经成功启动了！访问不到是因为**阿里云安全组未开放 3009 端口，****新增安全组规则**即可。



可以通过「实例 — 网络与安全组—添加入方向规则」中增加

* 优先级调为100
* 访问来源为任何位置
* 端口为3009

## 资源加载，跨域
往往因为服务端默认开启了一些安全校验，排查思路如下

* HTTP 环境下是否禁用了 CSP（避免 upgrade-insecure-requests），可以用`Strict-Transport-Security`
* Cookie 是否设置了`secure = true(强制 HTTPS 传输)`






