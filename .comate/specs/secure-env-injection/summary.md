# 敏感密钥从服务器环境变量注入 — 完成总结

## 改动概览

### `docker-compose.yml`
在 `app` 服务的 `environment` 块中新增两行显式声明：

```yaml
JWT_SECRET: ${JWT_SECRET}
MYSQL_PASSWORD: ${MYSQL_PASSWORD}
```

docker-compose 变量替换时，`.env` 中不再有这两个变量，会自动回落到宿主机环境变量，实现敏感密钥完全不落磁盘文件。

### `.env.example`
- 删除了 `MYSQL_PASSWORD` 和 `JWT_SECRET` 两行
- 文件顶部新增说明注释，指导新成员在服务器上通过 `export` 设置敏感变量

---

## 部署操作流程（上线前一次性设置）

在百度云服务器上执行：

```bash
export JWT_SECRET=$(openssl rand -hex 64)
export MYSQL_PASSWORD=your_strong_password
docker-compose up -d
```

---

## 本地开发说明

本地开发时，`.env` 文件可继续保留 `JWT_SECRET` 和 `MYSQL_PASSWORD`（已被 `.gitignore` 排除），不影响开发体验。生产服务器上的 `.env` 中不应包含这两个变量。

---

## 安全效果

| 项 | 改造前 | 改造后 |
|----|--------|--------|
| 密钥是否落磁盘 | ✅ 落 `.env` 文件 | ❌ 仅存在于宿主机内存环境 |
| 新成员是否可见密钥 | 可能（复制 `.env`）| 否（服务器环境变量仅 ops 可设置）|
| `.env.example` 是否含密钥 | ✅ 含占位符 | ❌ 已移除，改为说明注释 |