# MySQL 迁移方案

## 需求背景

当前使用 better-sqlite3 嵌入式数据库，文件级写锁在高并发写入场景存在瓶颈。迁移至 MySQL 可获得：
- 独立数据库服务，支持真正的并发读写
- 连接池管理，多 worker 共享数据库连接
- 更完善的运维生态（备份、监控、主从复制）

---

## 影响文件

| 文件 | 修改类型 | 说明 |
|---|---|---|
| `package.json` | 依赖变更 | 移除 `better-sqlite3`，新增 `mysql2` |
| `src/db/database.js` | 全量重写 | 从同步 SQLite API 改为 mysql2 promise 异步 API，使用连接池 |
| `src/routes/positions.js` | 微调 | 适配异步 CRUD（加 await），错误处理不变 |
| `src/routes/quote.js` | 无需改动 | 不涉及数据库 |
| `src/services/quoteService.js` | 无需改动 | 不涉及数据库 |
| `server.js` | 微调 | 优雅关机改为关闭 MySQL 连接池 |
| `.env.example` | 新增 | MySQL 连接环境变量示例 |
| `Dockerfile` | 更新 | 移除 SQLite 相关，添加 `WAIT_FOR_DB` 逻辑说明 |

---

## 架构技术方案

### 驱动选择
使用 `mysql2`（非 `mysql`），原因：
- 原生支持 Promise / async-await
- 预编译语句（Prepared Statements）防 SQL 注入
- 支持连接池（`createPool`），与 cluster 多进程兼容

### 连接池配置
```js
const pool = mysql2.createPool({
  host:            process.env.MYSQL_HOST     || 'localhost',
  port:            process.env.MYSQL_PORT     || 3306,
  user:            process.env.MYSQL_USER     || 'root',
  password:        process.env.MYSQL_PASSWORD || '',
  database:        process.env.MYSQL_DATABASE || 'astock',
  waitForConnections: true,
  connectionLimit:    10,     // 每个 worker 最多 10 个连接
  queueLimit:         0,      // 无限排队
});
```

### 建表 DDL（与 SQLite 等价）
```sql
CREATE TABLE IF NOT EXISTS positions (
  id          INT UNSIGNED    AUTO_INCREMENT PRIMARY KEY,
  type        ENUM('stock','fund') NOT NULL,
  code        VARCHAR(10)     NOT NULL,
  name        VARCHAR(50)     NOT NULL DEFAULT '',
  shares      DECIMAL(18,4)   NOT NULL CHECK(shares > 0),
  cost_price  DECIMAL(18,4)   NOT NULL CHECK(cost_price > 0),
  group_name  VARCHAR(30)     NOT NULL DEFAULT '',
  created_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### CRUD 接口设计（全异步）
- `getAllPositions()` → `async function`，返回 rows 数组
- `createPosition(data)` → 返回 `{ id: insertId }`
- `updatePosition(id, data)` → 返回 `{ changes: affectedRows }`
- `deletePosition(id)` → 返回 `{ changes: affectedRows }`
- `getPositionById(id)` → 返回单条记录或 undefined
- `initDatabase()` → 启动时执行建表 DDL，导出供 server.js 调用

### 迁移影响：同步 → 异步
better-sqlite3 是同步 API，mysql2 是异步 API。受影响的调用方：
- `src/routes/positions.js`：所有路由 handler 需加 `async/await`（大部分已是 async，微调即可）
- `server.js` 启动时需 `await initDatabase()` 后再监听端口

---

## 环境变量（.env.example）
```
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=root
MYSQL_PASSWORD=your_password
MYSQL_DATABASE=astock
PORT=3000
NODE_ENV=production
```

---

## 边界条件与异常处理

- 连接失败：`createPool` 延迟连接，首次查询时才真正建连；`initDatabase()` 失败时进程退出
- 并发写入：MySQL InnoDB 行锁，天然支持并发，无需 busy_timeout
- 优雅关机：`server.close()` 后调用 `pool.end()` 关闭连接池
- 本地开发：若无 MySQL 环境，提供 Docker Compose 一键启动 MySQL 的说明

---

## 预期成果

1. `npm install` 后安装 mysql2，移除 better-sqlite3
2. 配置 `.env`（或环境变量）后 `npm start` 正常启动，所有 CRUD 功能与迁移前一致
3. cluster 多进程每个 worker 独立连接池，并发写入无竞争
4. `npm run build` 前端构建不受影响