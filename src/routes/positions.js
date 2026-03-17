'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireAuth } = require('../middleware/auth');
const { fetchStockQuote, fetchFundQuote, normalizeStockCode } = require('../services/quoteService');

const SSE_INTERVAL_MS  = parseInt(process.env.SSE_INTERVAL_MS || '10000', 10);
const SSE_HEARTBEAT_MS = Math.min(Math.round(SSE_INTERVAL_MS * 2.5), 30000);
const MAX_SSE_CLIENTS  = parseInt(process.env.MAX_SSE_CLIENTS || '100', 10);
let   positionSseCount = 0;

const ok   = (res, data)                  => res.json({ code: 0, data });
const fail = (res, message, status = 400) => res.status(status).json({ code: 1, message });

// 输入白名单校验工具
const VALID_TYPES = Object.freeze(['stock', 'fund']);
const CODE_RE     = /^(sh|sz)?\d{6}$/i;

function validateInput({ type, code, shares, cost_price, group_name, stop_loss, take_profit } = {}) {
  if (type !== undefined && !VALID_TYPES.includes(type)) return 'type 必须为 stock 或 fund';
  if (code !== undefined) {
    if (typeof code !== 'string' || !CODE_RE.test(code.trim())) return '证券代码格式不正确（6 位数字，可带 sh/sz 前缀）';
    if (code.length > 10) return '证券代码超出长度限制';
  }
  if (shares !== undefined && (isNaN(shares) || Number(shares) <= 0 || Number(shares) > 1e10)) return '持有份额必须为 0~100亿 之间的正数';
  if (cost_price !== undefined && (isNaN(cost_price) || Number(cost_price) <= 0 || Number(cost_price) > 1e7)) return '成本价必须为 0~1000万 之间的正数';
  if (group_name !== undefined && typeof group_name === 'string' && group_name.length > 30) return '分组名称不能超过 30 个字符';
  if (stop_loss !== undefined && stop_loss !== null && stop_loss !== '' && (isNaN(stop_loss) || Number(stop_loss) < 0 || Number(stop_loss) > 1e7)) return '止损价格不合法';
  if (take_profit !== undefined && take_profit !== null && take_profit !== '' && (isNaN(take_profit) || Number(take_profit) < 0 || Number(take_profit) > 1e7)) return '目标价格不合法';
  return null;
}

/**
 * 聚合指定用户的持仓 + 行情数据，供 SSE 推送和 HTTP 响应复用
 */
async function buildPositionPayload(userId) {
  const positions  = await db.getAllPositions(userId);
  const stockCodes = positions.filter(p => p.type === 'stock').map(p => p.code);
  const fundCodes  = positions.filter(p => p.type === 'fund').map(p => p.code);
  const quotes     = {};

  if (stockCodes.length > 0) {
    try { Object.assign(quotes, await fetchStockQuote(stockCodes)); } catch (_) {}
  }
  for (const code of fundCodes) {
    try {
      const d   = await fetchFundQuote(code);
      const pct = d.gszzl || 0;
      quotes[code] = {
        name:         d.name,
        current:      +(d.dwjz * (1 + pct / 100)).toFixed(4),
        close:        d.dwjz,
        change_pct:   pct,
        change_amount: +(d.dwjz * pct / 100).toFixed(4),
      };
    } catch (_) {}
  }
  return { positions, quotes };
}

// ─── 所有路由均需登录 ──────────────────────────────────────────
router.use(requireAuth);

// GET /api/positions — 获取所有持仓
router.get('/', async (req, res) => {
  try {
    const positions = await db.getAllPositions(req.user.id);
    ok(res, positions);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

// GET /api/positions/stream — SSE 持仓实时推送
router.get('/stream', async (req, res) => {
  if (positionSseCount >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ code: 1, message: 'SSE 连接数已满，请稍后重试' });
  }
  positionSseCount++;

  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  function sseWrite(str) {
    res.write(str);
    if (typeof res.flush === 'function') res.flush();
  }

  const userId = req.user.id;

  // 连接建立时立即推送一次
  try {
    const payload = await buildPositionPayload(userId);
    sseWrite(`data: ${JSON.stringify({ code: 0, ...payload })}\n\n`);
  } catch (_) {}

  // 定时推送
  const pushTimer = setInterval(async () => {
    try {
      const payload = await buildPositionPayload(userId);
      sseWrite(`data: ${JSON.stringify({ code: 0, ...payload })}\n\n`);
    } catch (_) {}
  }, SSE_INTERVAL_MS);

  // 心跳防断连
  const heartbeat = setInterval(() => sseWrite(': ping\n\n'), SSE_HEARTBEAT_MS);

  req.on('close', () => {
    clearInterval(pushTimer);
    clearInterval(heartbeat);
    positionSseCount--;
  });
});

// POST /api/positions — 新增持仓
router.post('/', async (req, res) => {
  const { type, code, shares, cost_price, group_name } = req.body;

  const err = validateInput({ type, code, shares, cost_price, group_name });
  if (err) return fail(res, err);
  if (!type || !code || shares === undefined || cost_price === undefined) {
    return fail(res, '缺少必填参数：type、code、shares、cost_price');
  }

  const normalizedCode = type === 'stock' ? normalizeStockCode(code) : code.replace(/^(sh|sz)/i, '');

  try {
    const result = await db.createPosition({
      userId:     req.user.id,
      type,
      code:       normalizedCode,
      name:       '',
      shares:     Number(shares),
      cost_price: Number(cost_price),
      group_name: group_name || '',
    });

    // 异步回填证券名称，不阻塞响应
    backfillName(result.id, type, normalizedCode).catch(() => {});

    const position = await db.getPositionById(result.id);
    ok(res, position);
  } catch (err) {
    fail(res, err.message, 500);
  }
});

// PUT /api/positions/:id — 修改持仓
router.put('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return fail(res, '无效的持仓 ID');

  // 越权检查：确认该持仓属于当前用户
  const existing = await db.getPositionById(id);
  if (!existing) return fail(res, '持仓不存在', 404);
  if (existing.user_id !== req.user.id) return fail(res, '无权操作该持仓', 403);

  const { shares, cost_price, group_name, name, stop_loss, take_profit } = req.body;
  const updates = {};

  if (shares !== undefined) {
    if (isNaN(shares) || Number(shares) <= 0) return fail(res, '持有份额必须为正数');
    updates.shares = Number(shares);
  }
  if (cost_price !== undefined) {
    if (isNaN(cost_price) || Number(cost_price) <= 0) return fail(res, '成本价必须为正数');
    updates.cost_price = Number(cost_price);
  }
  if (group_name !== undefined) {
    if (typeof group_name === 'string' && group_name.length > 30) return fail(res, '分组名称不能超过 30 个字符');
    updates.group_name = group_name;
  }
  if (name !== undefined) {
    if (typeof name === 'string' && name.length > 50) return fail(res, '名称不能超过 50 个字符');
    updates.name = name;
  }
  // 止损/目标价：传 null 或空字符串则清除
  if (stop_loss !== undefined) {
    updates.stop_loss = (stop_loss === null || stop_loss === '') ? null : Number(stop_loss);
  }
  if (take_profit !== undefined) {
    updates.take_profit = (take_profit === null || take_profit === '') ? null : Number(take_profit);
  }

  try {
    const result = await db.updatePosition(id, updates, req.user.id);
    if (result.changes === 0) return fail(res, '更新失败', 400);
    ok(res, await db.getPositionById(id));
  } catch (err) {
    fail(res, err.message, 500);
  }
});

// DELETE /api/positions/:id — 删除持仓
router.delete('/:id', async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return fail(res, '无效的持仓 ID');

  // 越权检查
  const existing = await db.getPositionById(id);
  if (!existing) return fail(res, '持仓不存在', 404);
  if (existing.user_id !== req.user.id) return fail(res, '无权操作该持仓', 403);

  try {
    const result = await db.deletePosition(id, req.user.id);
    if (result.changes === 0) return fail(res, '持仓不存在', 404);
    ok(res, { id });
  } catch (err) {
    fail(res, err.message, 500);
  }
});

/**
 * 异步回填证券名称（内部调用，不校验 userId）
 */
async function backfillName(id, type, code) {
  let name = '';
  if (type === 'stock') {
    const quotes = await fetchStockQuote([code]);
    name = quotes[code]?.name || '';
  } else {
    const quote = await fetchFundQuote(code);
    name = quote?.name || '';
  }
  // 内部调用不传 userId，允许按 id 直接更新
  if (name) await db.updatePosition(id, { name });
}

module.exports = router;