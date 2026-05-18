# 服务端每日自动快照 — 实现总结

## 修复的问题

用户未登录期间数据空白：1月10日登录操作后，若1月11日～1月30日均未登录，则这段时间数据全部为空。

**根因**：快照保存完全依赖客户端触发，服务端没有独立的定时采集机制。

---

## 实现内容

### 新增文件

**`src/services/snapshotService.js`**（167 行）

- `isWeekday(date)` — 判断工作日，跳过周末
- `getBjToday()` — 获取北京时间今日日期
- `msUntilNextSnapshot()` — 计算到下一个工作日 15:10 的等待时长
- `generateSnapshotForUser(userId, snapDate)` — 为单用户拉取行情、计算资产、写入快照
- `runDailySnapshot()` — 并发处理所有活跃用户，记录成功/失败日志
- `startDailySnapshotScheduler()` — 链式 `setTimeout` 调度器，启动后自动循环

### 修改文件

| 文件 | 修改内容 |
|------|----------|
| `src/db/database.js` | 新增 `getAllActiveUsers()` 查询有持仓的用户 ID 列表 |
| `server.js` | Cluster 主进程中调用 `startDailySnapshotScheduler()`；开发模式在 Worker 进程中启动 |
| `docs/concurrency.md` | 新增"第六层：定时快照任务"章节，目录编号更新 |
| `docs/nodejs-high-concurrency.md` | 已解决项标记删除线，覆盖度一览新增定时任务条目 |

---

## 关键设计决策

1. **主进程运行**：Cluster 模式下定时器在主进程运行，避免 N 个 Worker 各自触发导致重复写入
2. **幂等安全**：`upsertDailySnapshot` 对历史日期使用 `INSERT IGNORE`，用户当天已登录保存的快照不会被覆盖
3. **链式 setTimeout**：避免 `setInterval` 在请求耗时超长时产生重叠
4. **无新依赖**：纯 Node.js 原生实现，不引入 `node-cron`
5. **单用户容错**：`Promise.allSettled` 保证单用户失败不影响其他用户
6. **行情缺失兜底**：行情获取失败时按成本价估算，仍保存快照

---

## 修复效果

- 用户 1 月 10 日后一直未登录，1 月 30 日登录时可看到 1 月 11 日～1 月 30 日（工作日）每天的数据
- 已登录用户当天数据由客户端精确写入（分钟级），服务端 15:10 的快照为兜底
- 周末不产生多余记录
