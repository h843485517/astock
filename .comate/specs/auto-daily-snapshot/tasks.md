# 服务端每日自动快照任务实现计划

- [x] Task 1: 新增数据库查询方法 `getAllActiveUsers`
    - 1.1: 在 `src/db/database.js` 中添加 `getAllActiveUsers()` 函数，查询 `positions` 表中所有 `DISTINCT user_id`
    - 1.2: 在 `module.exports` 中导出 `getAllActiveUsers`

- [x] Task 2: 创建 `src/services/snapshotService.js`
    - 2.1: 实现工具函数 `isWeekday(date)`、`getBjToday()`、`msUntilNextSnapshot()`
    - 2.2: 实现 `generateSnapshotForUser(userId, snapDate)` — 拉取持仓、行情，计算资产汇总，写入快照
    - 2.3: 实现 `runDailySnapshot()` — 获取所有活跃用户，并发调用 `generateSnapshotForUser`，记录成功/失败日志
    - 2.4: 实现 `startDailySnapshotScheduler()` — 链式 `setTimeout`，计算到下一个工作日 15:10 北京时间的等待时长

- [x] Task 3: 在 `server.js` 中集成定时快照任务
    - 3.1: 在 Cluster 主进程分支（`cluster.isPrimary && !IS_DEV`）中，调用 `initDatabase()` 后启动 `startDailySnapshotScheduler()`
    - 3.2: 在开发模式（`IS_DEV` 单进程）分支中，在 `app.listen` 回调内启动 `startDailySnapshotScheduler()`

- [x] Task 4: 更新 `docs/concurrency.md`
    - 4.1: 在目录中新增"第六层：定时快照任务"条目
    - 4.2: 新增章节，说明定时器仅在主进程运行的设计原因、触发时机、并发处理用户的方式

- [x] Task 5: 更新 `docs/nodejs-high-concurrency.md`
    - 5.1: 在"本项目可优化项"表格中，将"数据采集依赖客户端登录"标记为已解决
    - 5.2: 在覆盖度一览中新增"服务端定时任务"条目并标记 ✅
