'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { fetchStockQuote, fetchFundQuote } = require('../services/quoteService');

const ok   = (res, data)                  => res.json({ code: 0, data });
const fail = (res, message, status = 400) => res.status(status).json({ code: 1, message });

// 所有路由需登录
router.use(requireAuth);

/**
 * POST /api/history/snapshot
 * 保存今日快照。today_profit / today_pct 完全由前端基于实时行情计算后传入，
 * 服务端直接存储，不做二次推算，避免跨日基准混乱。
 * Body: { total_asset, total_cost, total_profit, today_profit, today_pct, total_pct, position_count }
 */
router.post('/snapshot', async (req, res) => {
  try {
    const {
      total_asset, total_cost, total_profit,
      today_profit, today_pct, total_pct, position_count,
    } = req.body;

    if (total_asset === undefined || total_cost === undefined) {
      return fail(res, '缺少必填参数：total_asset, total_cost');
    }

    // 北京时间今日日期
    const now = new Date();
    const bjTime = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000);
    const snap_date = bjTime.toISOString().slice(0, 10);

    await db.upsertDailySnapshot(req.user.id, {
      snap_date,
      total_asset:    Number(total_asset)    || 0,
      total_cost:     Number(total_cost)     || 0,
      total_profit:   Number(total_profit)   || 0,
      today_profit:   Number(today_profit)   || 0,
      today_pct:      Number(today_pct)      || 0,
      total_pct:      Number(total_pct)      || 0,
      position_count: Number(position_count) || 0,
    });

    ok(res, { snap_date });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

/**
 * GET /api/history/snapshots?year=2025&month=3
 * 获取指定年月的所有快照（用于日历渲染）
 * 若不传 year/month，默认返回当月
 */
router.get('/snapshots', async (req, res) => {
  try {
    const now = new Date();
    const bjOffset = 8 * 60;
    const bjTime = new Date(now.getTime() + (bjOffset + now.getTimezoneOffset()) * 60000);

    const year  = parseInt(req.query.year  || bjTime.getFullYear(),  10);
    const month = parseInt(req.query.month || bjTime.getMonth() + 1, 10);

    if (isNaN(year) || year < 2020 || year > 2100) return fail(res, '年份参数不合法');
    if (isNaN(month) || month < 1  || month > 12)  return fail(res, '月份参数不合法');

    // 计算月份首末日
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay   = new Date(year, month, 0).getDate();
    const endDate   = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const rows = await db.getDailySnapshots(req.user.id, startDate, endDate);
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

/**
 * GET /api/history/snapshots/range?start=2025-01-01&end=2025-12-31
 * 获取指定日期范围的快照（用于趋势图、统计等）
 */
router.get('/snapshots/range', async (req, res) => {
  try {
    const { start, end } = req.query;
    const dateRe = /^\d{4}-\d{2}-\d{2}$/;
    if (!start || !dateRe.test(start)) return fail(res, '请提供合法的 start 日期（YYYY-MM-DD）');
    if (!end   || !dateRe.test(end))   return fail(res, '请提供合法的 end 日期（YYYY-MM-DD）');
    if (start > end) return fail(res, 'start 不能晚于 end');

    const rows = await db.getDailySnapshots(req.user.id, start, end);
    ok(res, rows);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

/**
 * GET /api/history/snapshots/:date
 * 获取指定日期的单条快照
 */
router.get('/snapshots/:date', async (req, res) => {
  try {
    const { date } = req.params;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(res, '日期格式不正确（YYYY-MM-DD）');
    const row = await db.getSnapshotByDate(req.user.id, date);
    if (!row) return fail(res, '该日期暂无记录', 404);
    ok(res, row);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

module.exports = router;
