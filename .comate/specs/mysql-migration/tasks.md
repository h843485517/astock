# SQLite → MySQL 迁移：替换数据库驱动并适配异步 CRUD

- [x] 任务 1：安装依赖，移除 better-sqlite3，安装 mysql2
    - 1.1: 运行 `npm uninstall better-sqlite3` 卸载旧驱动
    - 1.2: 运行 `npm install mysql2` 安装新驱动
    - 1.3: 创建 `.env.example` 文件，包含 MYSQL_HOST/PORT/USER/PASSWORD/DATABASE/PORT/NODE_ENV 示例配置

- [x] 任务 2：全量重写 `src/db/database.js`，切换为 mysql2 连接池 + 异步 CRUD
    - 2.1: 顶部引入 mysql2，使用环境变量创建连接池（connectionLimit=10，waitForConnections=true）
    - 2.2: 实现 `initDatabase()` 异步函数：执行建表 DDL（utf8mb4，InnoDB），失败时 process.exit(1)
    - 2.3: 将 getAllPositions/createPosition/updatePosition/deletePosition/getPositionById 全部改为 async/await，使用 pool.execute()（预编译语句）
    - 2.4: `updatePosition` 保留 ALLOWED_UPDATE_FIELDS 白名单逻辑，动态拼接 SET 子句，字段名来自白名单而非用户输入
    - 2.5: 导出 pool 对象，供 server.js 优雅关机时调用 pool.end()

- [x] 任务 3：适配 `src/routes/positions.js`，所有 db 调用加 await
    - 3.1: GET / 路由：`db.getAllPositions()` 前加 await
    - 3.2: POST / 路由：`db.createPosition()`、`db.getPositionById()` 前加 await，backfillName 内 `db.updatePosition()` 前加 await
    - 3.3: PUT /:id 路由：`db.updatePosition()`、`db.getPositionById()` 前加 await
    - 3.4: DELETE /:id 路由：`db.deletePosition()` 前加 await

- [x] 任务 4：更新 `server.js`，启动时 await initDatabase()，优雅关机关闭连接池
    - 4.1: 引入 `initDatabase` 和 `pool`，将 `app.listen` 包裹在 async IIFE 中，先 await initDatabase() 再 listen
    - 4.2: `gracefulShutdown` 中将原来关闭 SQLite 的逻辑替换为 `await pool.end()`

- [x] 任务 5：验证与收尾
    - 5.1: 启动本地 MySQL（docker run 或本机），配置环境变量，运行 `node server.js` 验证启动和建表正常
    - 5.2: 用 curl 测试 POST /api/positions 新增、GET /api/positions 查询、DELETE 删除，确认 CRUD 正常
    - 5.3: 运行 `npm run build` 确认前端构建无影响
