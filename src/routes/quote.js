'use strict';

const express = require('express');
const router  = express.Router();

const SSE_INTERVAL_MS  = parseInt(process.env.SSE_INTERVAL_MS || '10000', 10);
const SSE_HEARTBEAT_MS = Math.min(Math.round(SSE_INTERVAL_MS * 2.5), 30000);

const {
  fetchStockQuote,
  fetchFundQuote,
  fetchMarketIndex,
  normalizeStockCode,
  getStaleCached,
  indexEmitter,
  getLatestIndexData,
} = require('../services/quoteService');

const ok = (res, data, extra = {}) => res.json({ code: 0, data, ...extra });
const fail = (res, message, status = 400) => res.status(status).json({ code: 1, message });

// GET /api/quote?codes=sh000001,sh600519
router.get('/quote', async (req, res) => {
  const { codes } = req.query;
  if (!codes) return fail(res, '缺少 codes 参数');

  const codeList = codes.split(',')
    .map((c) => c.trim())
    .filter(Boolean)
    .map(normalizeStockCode);

  if (codeList.length === 0) return fail(res, 'codes 参数为空');

  try {
    const data = await fetchStockQuote(codeList);
    ok(res, data);
  } catch (err) {
    // 降级：尝试返回缓存
    const stale = getStaleCached(`stock:${codeList.sort().join(',')}`);
    if (stale) return ok(res, stale, { stale: true });
    fail(res, `行情获取失败: ${err.message}`, 502);
  }
});

// GET /api/fund-quote?code=000001
router.get('/fund-quote', async (req, res) => {
  const { code } = req.query;
  if (!code || !/^\d{6}$/.test(code)) return fail(res, '基金代码格式不正确，应为 6 位数字');

  try {
    const data = await fetchFundQuote(code);
    ok(res, data);
  } catch (err) {
    const stale = getStaleCached(`fund:${code}`);
    if (stale) return ok(res, stale, { stale: true });
    fail(res, `基金估值获取失败: ${err.message}`, 502);
  }
});

// GET /api/market-index（一次性 JSON）
router.get('/market-index', async (req, res) => {
  try {
    const { data, stale } = await fetchMarketIndex();
    ok(res, data, { stale: !!stale });
  } catch (err) {
    fail(res, `大盘指数获取失败: ${err.message}`, 502);
  }
});

// SSE 当前连接数计数器（跨模块共享，单 worker 级别）
let sseClientCount = 0;
const MAX_SSE_CLIENTS = 100;

// GET /api/market-index/stream（SSE 持久推送）
router.get('/market-index/stream', (req, res) => {
  if (sseClientCount >= MAX_SSE_CLIENTS) {
    return res.status(503).json({ code: 1, message: 'SSE 连接数已满，请稍后重试' });
  }
  sseClientCount++;
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 禁止 nginx 缓冲
  res.flushHeaders();

  // 强制刷出缓冲区（兼容 compression 中间件）
  function sseWrite(str) {
    res.write(str);
    if (typeof res.flush === 'function') res.flush();
  }

  // 连接建立时立即推送最新数据（如有）
  const latest = getLatestIndexData();
  if (latest) {
    sseWrite(`data: ${JSON.stringify(latest)}\n\n`);
  }

  // 订阅后台轮询广播
  const onUpdate = (payload) => {
    sseWrite(`data: ${JSON.stringify(payload)}\n\n`);
  };
  indexEmitter.on('index-update', onUpdate);

  // 心跳，防止代理 / 负载均衡断开空闲连接
  const heartbeat = setInterval(() => {
    sseWrite(': ping\n\n');
  }, SSE_HEARTBEAT_MS);

  // 客户端断开时清理
  req.on('close', () => {
    indexEmitter.off('index-update', onUpdate);
    clearInterval(heartbeat);
    sseClientCount--;
  });
});

module.exports = router;