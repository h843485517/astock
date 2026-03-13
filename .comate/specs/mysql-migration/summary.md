# MySQL 迁移总结

## 完成情况

全部 5 个任务完成，CRUD 测试通过，前端构建无影响。

---

## 变更清单

| 文件 | 操作 | 说明 |
|---|---|---|
| `package.json` | 依赖变更 | 移除 `better-sqlite3`，新增 `mysql2` |
| `src/db/database.js` | 全量重写 | mysql2 连接池 + 全异步 CRUD + 预编译语句 |
| `src/routes/positions.js` | 全量重写 | 所有 db 调用加 await，校验逻辑不变 |
| `server.js` | 微调 | async IIFE 启动、pool.end() 优雅关机 |
| `.env.example` | 新增 | MySQL 环境变量配置示例 |

---

## 关键设计

**连接池**：每个 worker 持有独立连接池（`connectionLimit=10`），cluster 多进程下并发写入无竞争，彻底解决 SQLite 文件锁问题。

**SQL 注入防护**：全部使用 `pool.execute(sql, [values])` 预编译语句，字段名来自 `ALLOWED_UPDATE_FIELDS` 白名单，双重防护。

**启动顺序**：`initDatabase()` → 建表 DDL → `app.listen()`，确保服务就绪前数据库表已存在。

---

## 本地启动方式

```bash
# 1. 启动 MySQL（已通过 Homebrew 安装）
brew services start mysql

# 2. 创建数据库（首次）
mysql -u root -e "CREATE DATABASE IF NOT EXISTS astock CHARACTER SET utf8mb4;"

# 3. 启动服务
NODE_ENV=development MYSQL_HOST=127.0.0.1 MYSQL_USER=root MYSQL_PASSWORD="" MYSQL_DATABASE=astock node server.js
```

---

## 验证结果

- ✅ 数据库初始化：自动建表，启动日志输出"数据库初始化完成"
- ✅ 新增持仓：POST /api/positions → id=1, code=sh600519
- ✅ 查询持仓：GET /api/positions → 返回 1 条记录
- ✅ SQL 注入防护：恶意 type 字段被拦截
- ✅ 前端构建：npm run build 输出 dist/ 正常