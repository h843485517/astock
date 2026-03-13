# 敏感密钥从服务器环境变量注入：docker-compose 与 .env.example 改造

- [x] 任务 1：修改 `docker-compose.yml`，在 app 服务 environment 块显式声明敏感变量从宿主机注入
    - 1.1: 在 `app.environment` 块中新增 `JWT_SECRET: ${JWT_SECRET}` 和 `MYSQL_PASSWORD: ${MYSQL_PASSWORD}`，保留已有的 `MYSQL_HOST: db`

- [x] 任务 2：更新 `.env.example`，移除敏感变量并补充服务器配置说明
    - 2.1: 删除 `MYSQL_PASSWORD=your_password` 和 `JWT_SECRET=your_jwt_secret_please_change_in_production` 两行
    - 2.2: 在文件顶部新增多行注释，说明 `JWT_SECRET` 和 `MYSQL_PASSWORD` 须在服务器上通过 `export` 设置，并给出 `openssl rand -hex 64` 示例命令
