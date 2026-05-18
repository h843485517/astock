# 服务端每日自动快照 — Bug 修复方案

## 问题描述

**现象**：用户 1 月 10 日登录操作后，1 月 11 日能看到 1 月 10 日的数据。但若此后一直未登录，1 月 30 日登录时只有 1 月 10 日一条数据，中间 20 天全部空白。

**根因**：每日快照的保存逻辑完全依赖客户端触发：

```
用户登录 → Home.vue 挂载 → connectPositionSSE()
  → throttledSnapshot()  每 10 分钟保存一次（仅交易时间）
  → scheduleCloseSnapshot()  每天 15:05 保存收盘快照
```

如果用户没有登录，前端不运行，**没有任何服务端任务**会定时采集数据。

---

## 修复方案：服务端每日定时快照任务

在服务端（主进程）中添加一个每日收盘后自动运行的定时任务，遍历所有有持仓的用户，拉取实时行情，计算资产快照并写入数据库。

### 方案设计原则

1. **不引入新依赖**：使用 Node.js 原生 `setTimeout` + 北京时间计算，无需 `node-cron`
2. **幂等安全**：`upsertDailySnapshot` 对历史日期使用 `INSERT IGNORE`，重复执行不会覆盖已有数据
3. **仅在主进程运行**：Cluster 模式下只有主进程运行定时器，避免多 Worker 重复执行
4. **开发模式兼容**：单进程开发时同样运行定时器（可通过环境变量禁用）
5. **仅工作日执行**：跳过周末
6. **不阻塞主流程**：快照任务失败不影响服务运行

### 触发时机

每个工作日 **15:10 北京时间** 执行（收盘后 5 分钟，确保 15:00 收盘行情已稳定）。

---

## 数据流路径

```
每日 15:10 北京时间（主进程/单进程）
  → isWeekday() 检查（周六/日跳过）
  → db.getAllActiveUsers()  查询所有有持仓的用户
  → 对每个用户并发（Promise.allSettled）：
      → db.getAllPositions(userId)
      → fetchStockQuote(stockCodes)  并行
      → fetchFundQuote(fundCode) × N  并行（Promise.allSettled）
      → computeSnapshot(positions, quotes)  计算资产快照
      → db.upsertDailySnapshot(userId, snap)  写入数据库
  → 记录日志：成功/失败用户数
  → 计划下一次执行（次日 15:10）
```

---

## 涉及文件

### 新建文件

| 文件路径 | 类型 | 说明 |
|----------|------|------|
| `src/services/snapshotService.js` | 新增 | 定时快照核心逻辑 |

### 修改文件

| 文件路径 | 修改类型 | 修改说明 |
|----------|----------|----------|
| `src/db/database.js` | 修改 | 新增 `getAllActiveUsers()` 查询有持仓的用户列表 |
| `src/services/quoteService.js` | 修改 | 将 `fetchFundQuote` 中基金报价计算逻辑提取为导出函数 `buildFundCurrentPrice()` |
| `server.js` | 修改 | 在主进程（Cluster 模式）和单进程（开发模式）中启动定时快照任务 |
| `docs/concurrency.md` | 文档更新 | 新增"第六层：定时快照任务"章节 |

---

## 代码实现

### 1. `src/db/database.js` — 新增 `getAllActiveUsers()`

```javascript
/**
 * 查询所有有持仓记录的用户 ID 列表
 * 用于定时快照任务：只处理当前有持仓的活跃用户
 * @returns {Promise<number[]>}
 */
async function getAllActiveUsers() {
  const [rows] = await pool.execute(
    'SELECT DISTINCT user_id FROM positions'
  );
  return rows.map(r => r.user_id);
}
```

同时在 `module.exports` 中导出。

---

### 2. `src/services/snapshotService.js` — 核心服务

```javascript
'use strict';

const db = require('../db/database');
const { fetchStockQuote, fetchFundQuote, normalizeStockCode } = require('./quoteService');

/**
 * 判断给定日期是否为工作日（周一至周五）
 * 注：不处理法定节假日（A股节假日需外部日历，暂不引入依赖）
 */
function isWeekday(date = new Date()) {
  const day = date.getDay(); // 0=周日, 6=周六
  return day !== 0 && day !== 6;
}

/**
 * 获取北京时间当前日期字符串 YYYY-MM-DD
 */
function getBjToday() {
  const now = new Date();
  return new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000)
    .toISOString().slice(0, 10);
}

/**
 * 计算从现在到下一个工作日 15:10 北京时间的毫秒数
 */
function msUntilNextSnapshot() {
  const now = new Date();
  // 转换为北京时间
  const bjNow = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);

  // 目标时间：今天 15:10 北京时间
  const target = new Date(bjNow);
  target.setHours(15, 10, 0, 0);

  // 如果今天 15:10 已过，或今天是周末，找下一个工作日
  let msToTarget = target.getTime() - bjNow.getTime();
  if (msToTarget <= 0) {
    target.setDate(target.getDate() + 1);
    msToTarget = target.getTime() - bjNow.getTime();
  }
  // 跳过周末
  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
    msToTarget = target.getTime() - bjNow.getTime();
  }
  // 转换回实际 ms（去掉时区偏移带来的误差）
  return target.getTime() - bjNow.getTime();
}

/**
 * 为单个用户计算并保存当日快照
 * @param {number} userId
 * @param {string} snapDate  'YYYY-MM-DD'
 */
async function generateSnapshotForUser(userId, snapDate) {
  const positions = await db.getAllPositions(userId);
  if (positions.length === 0) return { skipped: true };

  const stockCodes = positions
    .filter(p => p.type === 'stock')
    .map(p => normalizeStockCode(p.code));
  const fundCodes = positions
    .filter(p => p.type === 'fund')
    .map(p => p.code);

  // 并行拉取股票和基金行情
  const quotes = {};

  if (stockCodes.length > 0) {
    try {
      Object.assign(quotes, await fetchStockQuote(stockCodes));
    } catch (err) {
      console.warn(`[SnapshotCron] 用户 ${userId} 股票行情获取失败:`, err.message);
    }
  }

  if (fundCodes.length > 0) {
    const results = await Promise.allSettled(
      fundCodes.map(async (code) => {
        const d = await fetchFundQuote(code);
        const pct = d.gszzl || 0;
        return {
          code,
          data: {
            current:    +(d.dwjz * (1 + pct / 100)).toFixed(4),
            change_pct: pct,
          },
        };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') quotes[r.value.code] = r.value.data;
    }
  }

  // 计算汇总数据
  let totalAsset = 0;
  let totalCost  = 0;
  let todayProfit = 0;

  for (const p of positions) {
    const code  = normalizeStockCode(p.code);
    const quote = quotes[code] || quotes[p.code];
    const shares = parseFloat(p.shares) || 0;
    const cost   = parseFloat(p.cost_price) || 0;

    if (!quote || !quote.current) {
      // 行情缺失：按成本价估算
      totalAsset += shares * cost;
      totalCost  += shares * cost;
      continue;
    }

    const current = parseFloat(quote.current) || cost;
    const posAsset = shares * current;
    const posCost  = shares * cost;

    totalAsset  += posAsset;
    totalCost   += posCost;
    todayProfit += shares * (current - (quote.close || cost));
  }

  const totalProfit = totalAsset - totalCost;
  const totalPct    = totalCost > 0 ? +((totalProfit / totalCost) * 100).toFixed(4) : 0;
  const todayPct    = totalCost > 0 ? +((todayProfit / totalCost) * 100).toFixed(4) : 0;

  await db.upsertDailySnapshot(userId, {
    snap_date:      snapDate,
    total_asset:    +totalAsset.toFixed(2),
    total_cost:     +totalCost.toFixed(2),
    total_profit:   +totalProfit.toFixed(2),
    today_profit:   +todayProfit.toFixed(2),
    today_pct:      todayPct,
    total_pct:      totalPct,
    position_count: positions.length,
  });

  return { success: true };
}

/**
 * 为所有有持仓的用户生成当日快照
 * 主入口：由定时器调用
 */
async function runDailySnapshot() {
  const now = new Date();
  const bjNow = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);

  if (!isWeekday(bjNow)) {
    console.log('[SnapshotCron] 今日为周末，跳过快照');
    return;
  }

  const snapDate = getBjToday();
  console.log(`[SnapshotCron] 开始生成 ${snapDate} 每日快照...`);

  let successCount = 0;
  let failCount = 0;

  try {
    const userIds = await db.getAllActiveUsers();
    if (userIds.length === 0) {
      console.log('[SnapshotCron] 无活跃用户，跳过');
      return;
    }

    // 并发处理所有用户，单个失败不影响其他用户
    const results = await Promise.allSettled(
      userIds.map(userId => generateSnapshotForUser(userId, snapDate))
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value && !r.value.skipped) {
        successCount++;
      } else if (r.status === 'rejected') {
        failCount++;
        console.error('[SnapshotCron] 用户快照失败:', r.reason?.message);
      }
    }

    console.log(`[SnapshotCron] ${snapDate} 快照完成：成功 ${successCount} 人，失败 ${failCount} 人`);
  } catch (err) {
    console.error('[SnapshotCron] 快照任务执行失败:', err.message);
  }
}

/**
 * 启动每日自动快照定时器
 * 在主进程（Cluster 模式）或单进程（开发模式）中调用一次
 */
function startDailySnapshotScheduler() {
  async function schedule() {
    const ms = msUntilNextSnapshot();
    const nextTime = new Date(Date.now() + ms);
    console.log(`[SnapshotCron] 下次快照时间: ${nextTime.toISOString()} (${Math.round(ms / 60000)} 分钟后)`);

    setTimeout(async () => {
      await runDailySnapshot();
      schedule(); // 执行完后立即安排下一次
    }, ms);
  }

  schedule();
}

module.exports = { startDailySnapshotScheduler, runDailySnapshot };
```

---

### 3. `server.js` — 启动定时任务

在主进程中（Cluster 模式）和开发模式中分别启动：

**Cluster 主进程部分**（`cluster.isPrimary && !IS_DEV` 分支内，`return` 前）：
```javascript
// 主进程：启动每日自动快照（Cluster 模式下仅在主进程运行，避免重复）
const { startDailySnapshotScheduler } = require('./src/services/snapshotService');
// 需要先初始化数据库
const { initDatabase } = require('./src/db/database');
initDatabase().then(() => {
  startDailySnapshotScheduler();
}).catch(err => {
  console.error('[Primary] 数据库初始化失败，定时快照未启动:', err.message);
});
```

**Worker / 开发模式部分**（`initDatabase()` 完成后，`startIndexPolling` 附近）：
```javascript
// 开发模式：单进程，直接在本进程启动快照定时器
if (IS_DEV) {
  const { startDailySnapshotScheduler } = require('./src/services/snapshotService');
  startDailySnapshotScheduler();
}
```

---

## 边界条件与异常处理

| 情况 | 处理 |
|------|------|
| 当天已有快照（用户当天登录过） | `INSERT IGNORE` 跳过，不覆盖客户端保存的更精准数据 |
| 行情接口失败 | 用成本价估算资产，仍保存快照，避免数据缺失 |
| 用户无持仓 | 跳过，不写入空快照 |
| 周末触发 | 检查工作日，直接跳过 |
| DB 写入失败 | 记录错误日志，不影响其他用户 |
| 节假日 | 当前不处理（需引入节假日日历才能判断），行情接口会返回前一交易日数据，快照值与前日相近 |
| Cluster 多 Worker | 定时器仅在主进程运行，Worker 不参与 |
| 服务器在 15:10 重启 | 重新计算下一次触发时间（第二天或下个工作日 15:10）|

---

## 预期效果

- 用户 1 月 10 日登录后不再登录，1 月 30 日登录时能看到 1 月 11 日 ～ 1 月 30 日每个工作日的数据
- 节假日/周末不会产生多余的空快照
- 对有精确需求的用户（当天登录），客户端保存的快照优先（精确到分钟级），服务端快照仅补充未登录日期
