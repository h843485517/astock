'use strict';

const db = require('../db/database');
const { fetchStockQuote, fetchFundQuote, normalizeStockCode } = require('./quoteService');

// ─── 工具函数 ─────────────────────────────────────────────────

/**
 * 判断给定日期是否为工作日（周一至周五）
 * 注：不处理法定节假日（A 股节假日需外部日历，暂不引入依赖）
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
  // 转为北京时间
  const bjNow = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);

  // 目标：今天 15:10 北京时间
  const target = new Date(bjNow);
  target.setHours(15, 10, 0, 0);

  // 若今天 15:10 已过，移到明天
  if (target.getTime() <= bjNow.getTime()) {
    target.setDate(target.getDate() + 1);
  }

  // 跳过周末
  while (target.getDay() === 0 || target.getDay() === 6) {
    target.setDate(target.getDate() + 1);
  }

  // 计算实际等待 ms（target 是北京时间，需换算回 UTC ms 差值）
  return target.getTime() - bjNow.getTime();
}

// ─── 核心逻辑 ─────────────────────────────────────────────────

/**
 * 为单个用户计算并保存当日收益快照
 * @param {number} userId
 * @param {string} snapDate  'YYYY-MM-DD'
 * @returns {Promise<{success: boolean}|{skipped: boolean}>}
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

  const quotes = {};

  // 股票行情
  if (stockCodes.length > 0) {
    try {
      Object.assign(quotes, await fetchStockQuote(stockCodes));
    } catch (err) {
      console.warn(`[SnapshotCron] 用户 ${userId} 股票行情获取失败:`, err.message);
    }
  }

  // 基金行情（并行请求，单只失败不影响其他）
  if (fundCodes.length > 0) {
    const results = await Promise.allSettled(
      fundCodes.map(async (code) => {
        const d = await fetchFundQuote(code);
        const pct = d.gszzl || 0;
        return {
          code,
          data: {
            current:      +(d.dwjz * (1 + pct / 100)).toFixed(4),
            close:        d.dwjz,
            change_pct:   pct,
          },
        };
      })
    );
    for (const r of results) {
      if (r.status === 'fulfilled') quotes[r.value.code] = r.value.data;
    }
  }

  // 计算汇总数据
  let totalAsset  = 0;
  let totalCost   = 0;
  let todayProfit = 0;

  for (const p of positions) {
    const code   = normalizeStockCode(p.code);
    const quote  = quotes[code] || quotes[p.code];
    const shares = parseFloat(p.shares)     || 0;
    const cost   = parseFloat(p.cost_price) || 0;

    if (!quote || !quote.current) {
      // 行情缺失：按成本价估算（资产不变，今日收益为 0）
      totalAsset += shares * cost;
      totalCost  += shares * cost;
      continue;
    }

    const current  = parseFloat(quote.current) || cost;
    const prevClose = parseFloat(quote.close)  || cost;

    totalAsset  += shares * current;
    totalCost   += shares * cost;
    todayProfit += shares * (current - prevClose);
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
 * 定时器主入口
 */
async function runDailySnapshot() {
  const now   = new Date();
  const bjNow = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);

  if (!isWeekday(bjNow)) {
    console.log('[SnapshotCron] 今日为周末，跳过快照');
    return;
  }

  const snapDate = getBjToday();
  console.log(`[SnapshotCron] 开始生成 ${snapDate} 每日快照...`);

  let successCount = 0;
  let skippedCount = 0;
  let failCount    = 0;

  try {
    const userIds = await db.getAllActiveUsers();
    if (userIds.length === 0) {
      console.log('[SnapshotCron] 无活跃用户，跳过');
      return;
    }

    const results = await Promise.allSettled(
      userIds.map(userId => generateSnapshotForUser(userId, snapDate))
    );

    for (const r of results) {
      if (r.status === 'fulfilled') {
        r.value && r.value.skipped ? skippedCount++ : successCount++;
      } else {
        failCount++;
        console.error('[SnapshotCron] 用户快照失败:', r.reason?.message);
      }
    }

    console.log(
      `[SnapshotCron] ${snapDate} 快照完成：` +
      `成功 ${successCount} 人，跳过（无持仓）${skippedCount} 人，失败 ${failCount} 人`
    );
  } catch (err) {
    console.error('[SnapshotCron] 快照任务执行失败:', err.message);
  }
}

// ─── 调度器 ───────────────────────────────────────────────────

/**
 * 启动每日自动快照定时器
 * 使用链式 setTimeout（而非 setInterval）确保上一次完成后再等待下一次
 * 在主进程（Cluster 模式）或单进程（开发模式）中调用一次即可
 */
function startDailySnapshotScheduler() {
  async function schedule() {
    const ms       = msUntilNextSnapshot();
    const nextTime = new Date(Date.now() + ms);
    const bjNext   = new Date(nextTime.getTime() + (8 * 60 + nextTime.getTimezoneOffset()) * 60000);
    console.log(
      `[SnapshotCron] 下次快照时间: ${bjNext.toISOString().slice(0, 16)} 北京时间` +
      `（约 ${Math.round(ms / 60000)} 分钟后）`
    );

    setTimeout(async () => {
      await runDailySnapshot();
      schedule(); // 执行完后立即安排下一次
    }, ms);
  }

  schedule();
}

module.exports = { startDailySnapshotScheduler, runDailySnapshot };
