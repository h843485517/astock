'use strict';

const express = require('express');
const router  = express.Router();
const db      = require('../db/database');
const { requireAuth }                        = require('../middleware/auth');
const { fetchStockHistory, buildContext, streamChat } = require('../services/chatService');
const { normalizeStockCode }                 = require('../services/quoteService');

const MAX_MESSAGE_LEN = 500;

const ok   = (res, data)                  => res.json({ code: 0, data });
const fail = (res, message, status = 400) => res.status(status).json({ code: 1, message });

// GET /api/chat/stream?message=...&codes=sh600519,000001
// SSE 流式 AI 回复，需登录
router.get('/stream', requireAuth, async (req, res) => {
  let { message, codes } = req.query;

  if (!message || !message.trim()) {
    return fail(res, '请输入问题');
  }

  // 截断超长消息
  if (message.length > MAX_MESSAGE_LEN) {
    message = message.slice(0, MAX_MESSAGE_LEN);
  }

  // 设置 SSE 响应头；Content-Encoding: identity 显式禁用 gzip/deflate，
  // 防止 compression 中间件缓冲数据导致流式内容无法实时输出
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.setHeader('Content-Encoding',  'identity');
  res.flushHeaders();

  // 禁用 TCP Nagle 算法，确保每个 token 立即发出，不被内核攒包延迟
  if (res.socket) {
    res.socket.setNoDelay(true);
  }

  function sseWrite(str) {
    res.write(str);
    if (typeof res.flush === 'function') res.flush();
  }

  try {
    const userId   = req.user.id;
    const positions = await db.getAllPositions(userId);

    // 获取持仓行情（从 positions 路由中的 buildPositionPayload 复用逻辑）
    const { fetchStockQuote, fetchFundQuote } = require('../services/quoteService');
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
          name:          d.name,
          current:       +(d.dwjz * (1 + pct / 100)).toFixed(4),
          close:         d.dwjz,
          change_pct:    pct,
          change_amount: +(d.dwjz * pct / 100).toFixed(4),
        };
      } catch (_) {}
    }

    // 拉取用户选中标的的历史行情
    const historiesMap = {};
    const selectedCodes = (codes && codes.trim())
      ? codes.split(',').map(c => c.trim()).filter(Boolean).map(c => normalizeStockCode(c))
      : [];

    if (selectedCodes.length > 0) {
      await Promise.all(
        selectedCodes.map(async (code) => {
          const hist = await fetchStockHistory(code, 30);
          if (hist.length > 0) historiesMap[code] = hist;
        })
      );
    }

    // 若前端传入了 codes，则只将选中的标的纳入 AI 上下文；未选时沿用全量持仓
    const filteredPositions = selectedCodes.length > 0
      ? positions.filter(p => selectedCodes.includes(normalizeStockCode(p.code)))
      : positions;

    const context = buildContext(filteredPositions, quotes, historiesMap);
    await streamChat(message.trim(), context, res);

  } catch (err) {
    console.error('[ChatRoute] stream error:', err.message);
    sseWrite(`data: ${JSON.stringify({ error: 'SERVER_ERROR', message: err.message })}\n\n`);
    res.end();
  }
});

// GET /api/chat/history-quote?code=sh600519
// 获取指定标的近 30 日历史行情
router.get('/history-quote', requireAuth, async (req, res) => {
  const { code } = req.query;
  if (!code) return fail(res, '缺少 code 参数');

  const normalizedCode = normalizeStockCode(code.trim());
  try {
    const data = await fetchStockHistory(normalizedCode, 30);
    ok(res, data);
  } catch (err) {
    fail(res, `历史行情获取失败: ${err.message}`, 502);
  }
});

module.exports = router;