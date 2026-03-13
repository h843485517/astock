'use strict';

const axios  = require('axios');
const iconv  = require('iconv-lite');
const EventEmitter = require('events');

// 供 SSE 路由订阅的事件总线
const indexEmitter = new EventEmitter();
indexEmitter.setMaxListeners(200); // 支持最多 200 个并发 SSE 客户端

// 最新大盘数据，新连接时立即推送
let latestIndexData = null;

// 内存缓存：key -> { data, timestamp }
const cache = new Map();
const CACHE_TTL       = parseInt(process.env.QUOTE_CACHE_TTL_MS || '60000', 10); // 持仓行情默认 60s
const INDEX_CACHE_TTL = 10 * 1000; // 大盘指数 10s，与前端轮询对齐

function getCached(key, ttl = CACHE_TTL) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > ttl) return null;
  return entry.data;
}

function setCache(key, data) {
  cache.set(key, { data, timestamp: Date.now() });
}

function getStaleCached(key) {
  const entry = cache.get(key);
  return entry ? entry.data : null;
}

/**
 * 将 6 位纯数字代码自动补全 sh/sz 前缀
 */
function normalizeStockCode(code) {
  if (/^(sh|sz)/i.test(code)) return code.toLowerCase();
  if (/^6/.test(code)) return `sh${code}`;
  if (/^[03]/.test(code)) return `sz${code}`;
  return code;
}

/**
 * 批量获取股票/指数行情（新浪财经）
 * @param {string[]} codes  已含 sh/sz 前缀的代码数组
 * @returns {Promise<{ [code]: QuoteItem }>}
 */
async function fetchStockQuote(codes, ttl = CACHE_TTL) {
  const cacheKey = `stock:${codes.sort().join(',')}`;
  const hit = getCached(cacheKey, ttl);
  if (hit) return { ...hit, cached: true };

  const codesStr = codes.join(',');
  const response = await axios.get(`http://hq.sinajs.cn/list=${codesStr}`, {
    headers: {
      Referer: 'http://finance.sina.com.cn',
      'User-Agent': 'Mozilla/5.0',
    },
    timeout: 5000,
    responseType: 'arraybuffer',
  });

  // 新浪返回 GBK 编码，使用 iconv-lite 解码
  const rawText = iconv.decode(Buffer.from(response.data), 'gbk');
  const result = parseStockResponse(rawText, codes);
  setCache(cacheKey, result);
  return result;
}

/**
 * 解析新浪行情字符串
 * 格式: var hq_str_sh600519="贵州茅台,1920.00,1800.00,1930.00,1930.00,1895.00,1930.00,1930.10,12345,23456789,..."
 * 字段顺序: 0-名称, 1-今开, 2-昨收, 3-当前, 4-最高, 5-最低, 6-买一, 7-卖一, 8-成交量(手), 9-成交额
 */
function parseStockResponse(text, codes) {
  const result = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/hq_str_([a-zA-Z0-9]+)="([^"]+)"/);
    if (!match) continue;

    const code = match[1].toLowerCase();
    const parts = match[2].split(',');
    if (parts.length < 10) continue;

    // iconv-lite 已完成整体解码，parts[0] 即为正确的 UTF-8 字符串
    const name = parts[0];

    const open    = parseFloat(parts[1]) || 0;
    const close   = parseFloat(parts[2]) || 0; // 昨收
    const current = parseFloat(parts[3]) || 0;
    const high    = parseFloat(parts[4]) || 0;
    const low     = parseFloat(parts[5]) || 0;
    const volume  = parseInt(parts[8], 10) || 0;

    const change_pct = close > 0 ? +((current - close) / close * 100).toFixed(2) : 0;
    const change_amount = +(current - close).toFixed(2);

    result[code] = { name, current, open, high, low, close, change_pct, change_amount, volume };
  }

  return result;
}

/**
 * 获取单只基金实时估值（天天基金）
 * @param {string} code  6 位基金代码
 * @returns {Promise<FundQuoteItem>}
 */
async function fetchFundQuote(code) {
  const cacheKey = `fund:${code}`;
  const hit = getCached(cacheKey);
  if (hit) return { ...hit, cached: true };

  const response = await axios.get(
    `http://fundgz.1234567.com.cn/js/${code}.js`,
    {
      headers: { Referer: 'http://fund.eastmoney.com' },
      timeout: 5000,
    }
  );

  const text = response.data;
  // JSONP 格式: jsonpgz({...});
  const jsonMatch = text.match(/jsonpgz\((\{.*?\})\)/s);
  if (!jsonMatch) throw new Error(`基金 ${code} 数据解析失败`);

  const obj = JSON.parse(jsonMatch[1]);
  const result = {
    code: obj.fundcode,
    name: obj.name,
    dwjz: parseFloat(obj.dwjz) || 0,       // 昨日净值
    gsz: parseFloat(obj.gsz) || 0,          // 估算净值
    gszzl: parseFloat(obj.gszzl) || 0,      // 估算涨跌幅(%)
    gztime: obj.gztime || '',               // 估值时间
  };

  setCache(cacheKey, result);
  return result;
}

/**
 * 解析全球指数行情字符串（新浪 gb_ 系列）
 * 格式: name, current, prev_close, change_pct_str(+0.20%), change_amount_str(+83.60), high, low, open,...
 */
function parseGlobalResponse(text) {
  const result = {};
  const lines = text.split('\n');

  for (const line of lines) {
    const match = line.match(/hq_str_(gb_[a-zA-Z0-9]+)="([^"]+)"/);
    if (!match) continue;

    const code  = match[1].toLowerCase();
    const parts = match[2].split(',');
    if (parts.length < 5) continue;

    const name          = parts[0];
    const current       = parseFloat(parts[1]) || 0;
    // 新浪全球指数实际字段顺序：name, current, change_pct, change_amount, prev_close, ...
    const change_pct    = parseFloat(parts[2]) || 0;
    const change_amount = parseFloat(parts[3]) || 0;
    const close         = parseFloat(parts[4]) || 0;

    result[code] = { name, current, close, change_pct, change_amount, isGlobal: true };
  }

  return result;
}

/**
 * 批量获取全球指数（新浪 gb_ 系列）
 */
async function fetchGlobalIndex(codes) {
  const codesStr = codes.join(',');
  const response = await axios.get(`http://hq.sinajs.cn/list=${codesStr}`, {
    headers: {
      Referer: 'http://finance.sina.com.cn',
      'User-Agent': 'Mozilla/5.0',
    },
    timeout: 5000,
    responseType: 'arraybuffer',
  });
  // 全球指数为英文，UTF-8 可直接解码
  const rawText = iconv.decode(Buffer.from(response.data), 'gbk');
  return parseGlobalResponse(rawText);
}

/**
 * 获取大盘指数（A股6只 + 全球3只）
 */
async function fetchMarketIndex() {
  const A_CODES = ['sh000001', 'sz399001', 'sz399006', 'sh000016', 'sh000300', 'sh000905'];
  const G_CODES = ['gb_dji', 'gb_ixic', 'gb_inx'];
  const cacheKey = 'market_index';

  try {
    const [aData, gData] = await Promise.all([
      fetchStockQuote(A_CODES, INDEX_CACHE_TTL),
      fetchGlobalIndex(G_CODES).catch(() => ({})), // 全球指数失败不阻断
    ]);
    const data = { ...aData, ...gData };
    setCache(cacheKey, data);
    return { data, stale: false };
  } catch (err) {
    const stale = getStaleCached(cacheKey);
    if (stale) return { data: stale, stale: true };
    throw err;
  }
}

/**
 * 启动大盘指数后台轮询，每 intervalMs 抓取一次并广播给所有 SSE 客户端
 */
function startIndexPolling(intervalMs = 10000) {
  async function poll() {
    try {
      const result = await fetchMarketIndex();
      latestIndexData = result;
      indexEmitter.emit('index-update', result);
    } catch (err) {
      console.error('[IndexPolling] 抓取失败:', err.message);
    }
  }
  // 启动时立即执行一次
  poll();
  setInterval(poll, intervalMs);
}

module.exports = {
  fetchStockQuote,
  fetchFundQuote,
  fetchMarketIndex,
  startIndexPolling,
  indexEmitter,
  getLatestIndexData: () => latestIndexData,
  normalizeStockCode,
  getStaleCached,
};