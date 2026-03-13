# 敏感密钥从服务器环境变量注入方案

## 需求背景

当前 `docker-compose.yml` 的 app 服务使用 `env_file: .env`，将包括 `JWT_SECRET`、`MYSQL_PASSWORD` 在内的所有配置一并从 `.env` 文件注入容器。大团队部署时 `.env` 文件会在服务器磁盘上漂移，存在泄漏风险且无法审计。

目标：将敏感密钥（`JWT_SECRET`、`MYSQL_PASSWORD`）改为**从服务器宿主机环境变量注入**，`.env` 文件仅保留非敏感配置。

---

## 架构方案

### 变量分类

| 变量 | 是否敏感 | 注入方式 |
|------|---------|---------|
| `JWT_SECRET` | ✅ 敏感 | 服务器宿主机环境变量 |
| `MYSQL_PASSWORD` | ✅ 敏感 | 服务器宿主机环境变量 |
| `PORT`、`NODE_ENV`、`SSE_INTERVAL_MS`、`MYSQL_DATABASE`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_HOST`、`JWT_EXPIRES_IN`、`OLLAMA_BASE_URL`、`OLLAMA_MODEL` | ❌ 非敏感 | `.env` 文件（保持现状）|

### docker-compose 注入原理

docker-compose 读取变量有优先级：`environment` 块 > `env_file` > 宿主机环境变量。

利用这一特性：
- `env_file: .env` 继续加载非敏感变量
- `environment` 块中显式声明 `JWT_SECRET: ${JWT_SECRET}` 和 `MYSQL_PASSWORD: ${MYSQL_PASSWORD}`，docker-compose 进行变量替换时，由于 `.env` 中不再有这两个变量，会自动回落到宿主机环境变量

---

## 影响文件

### 1. `docker-compose.yml`（修改）
- **app 服务 `environment` 块**：新增 `JWT_SECRET: ${JWT_SECRET}` 和 `MYSQL_PASSWORD: ${MYSQL_PASSWORD}`，保留 `MYSQL_HOST: db`
- **db 服务**：`MYSQL_ROOT_PASSWORD: ${MYSQL_PASSWORD}` 无需改动，docker-compose 变量替换会从宿主机取值

### 2. `.env.example`（修改）
- 删除 `JWT_SECRET` 和 `MYSQL_PASSWORD` 两行
- 新增注释说明这两个变量需要在服务器上通过 `export` 设置

---

## 实现细节

### docker-compose.yml app 服务 environment 块改动

```yaml
environment:
  MYSQL_HOST: db
  JWT_SECRET: ${JWT_SECRET}       # 从宿主机环境变量注入，不在 .env 中
  MYSQL_PASSWORD: ${MYSQL_PASSWORD}  # 从宿主机环境变量注入，不在 .env 中
```

### .env.example 改动

删除：
```
MYSQL_PASSWORD=your_password
JWT_SECRET=your_jwt_secret_please_change_in_production
```

在文件头部新增服务器配置说明注释：
```
# =====================================================================
# 敏感变量（JWT_SECRET、MYSQL_PASSWORD）不在此文件中配置
# 请在服务器上通过环境变量设置，例如：
#   export JWT_SECRET=$(openssl rand -hex 64)
#   export MYSQL_PASSWORD=your_strong_password
# 然后执行 docker-compose up -d
# =====================================================================
```

---

## 边界条件与异常处理

- `auth.js` 中已有 `JWT_SECRET` 未配置时的降级逻辑（随机临时密钥 + 警告日志），**无需修改**
- 若宿主机未设置 `JWT_SECRET` 或 `MYSQL_PASSWORD`，docker-compose 会输出 `variable is not set` 警告，容器启动后应用会走降级逻辑，不会静默失效

---

## 预期成果

- `docker-compose up` 时，敏感密钥从宿主机环境变量注入，`.env` 文件中不含任何密钥
- 新成员 clone 项目后，按 `.env.example` 配置非敏感变量，按注释提示在服务器设置敏感变量
- 不影响现有本地开发流程（本地仍可在 `.env` 中配置所有变量用于开发）