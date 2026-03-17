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

// 数据源健康状态（记录连续失败次数，失败多次时降级优先级）
const sourceHealth = { sina: 0, tencent: 0 };
const SOURCE_FAIL_THRESHOLD = 3; // 连续失败超过此次数则降级

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

// ─── 新浪财经数据源 ────────────────────────────────────────────

/**
 * 解析新浪行情字符串
 * 格式: var hq_str_sh600519="贵州茅台,1920.00,1800.00,1930.00,..."
 * 字段: 0-名称, 1-今开, 2-昨收, 3-当前, 4-最高, 5-最低, 8-成交量(手)
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

    const name   = parts[0];
    const open    = parseFloat(parts[1]) || 0;
    const close   = parseFloat(parts[2]) || 0; // 昨收
    const current = parseFloat(parts[3]) || 0;
    const high    = parseFloat(parts[4]) || 0;
    const low     = parseFloat(parts[5]) || 0;
    const volume  = parseInt(parts[8], 10) || 0;

    const change_pct    = close > 0 ? +((current - close) / close * 100).toFixed(2) : 0;
    const change_amount = +(current - close).toFixed(2);

    result[code] = { name, current, open, high, low, close, change_pct, change_amount, volume };
  }

  return result;
}

async function fetchStockQuoteSina(codes, ttl = CACHE_TTL) {
  const codesStr = codes.join(',');
  const response = await axios.get(`http://hq.sinajs.cn/list=${codesStr}`, {
    headers: {
      Referer: 'http://finance.sina.com.cn',
      'User-Agent': 'Mozilla/5.0',
    },
    timeout: 5000,
    responseType: 'arraybuffer',
  });
  const rawText = iconv.decode(Buffer.from(response.data), 'gbk');
  return parseStockResponse(rawText, codes);
}

// ─── 腾讯财经数据源（备用）────────────────────────────────────

/**
 * 将 sh/sz 前缀转为腾讯格式（sh600519 → sh600519，sz000001 → sz000001）
 * 腾讯与新浪前缀相同，直接可用
 */
function parseTencentResponse(text) {
  const result = {};
  const lines = text.split('\n');

  for (const line of lines) {
    // 腾讯格式: v_sh600519="1~贵州茅台~600519~1930.00~1800.00~1920.00~..."
    // 字段: 0-市场, 1-名称, 2-代码, 3-当前价, 4-昨收, 5-今开, 6-成交量, 7-外盘, 8-内盘,
    //       9-买一价, ..., 31-最高, 32-最低, ..., 37-涨跌幅(%), 38-涨跌额
    const match = line.match(/v_([a-zA-Z0-9]+)="([^"]+)"/);
    if (!match) continue;

    const rawCode = match[1].toLowerCase();
    // 跳过全球指数格式
    if (rawCode.startsWith('gb_')) continue;

    const parts = match[2].split('~');
    if (parts.length < 38) continue;

    const name          = parts[1];
    const current       = parseFloat(parts[3])  || 0;
    const close         = parseFloat(parts[4])  || 0; // 昨收
    const open          = parseFloat(parts[5])  || 0;
    const volume        = parseInt(parts[6], 10) || 0;
    const high          = parseFloat(parts[33]) || 0;
    const low           = parseFloat(parts[34]) || 0;
    const change_pct    = parseFloat(parts[32]) || (close > 0 ? +((current - close) / close * 100).toFixed(2) : 0);
    const change_amount = parseFloat(parts[31]) || +(current - close).toFixed(2);

    result[rawCode] = { name, current, open, high, low, close, change_pct, change_amount, volume };
  }

  return result;
}

async function fetchStockQuoteTencent(codes) {
  const codesStr = codes.join(',');
  const response = await axios.get(`http://qt.gtimg.cn/q=${codesStr}`, {
    headers: {
      Referer: 'https://gu.qq.com',
      'User-Agent': 'Mozilla/5.0',
    },
    timeout: 5000,
    responseType: 'arraybuffer',
  });
  const rawText = iconv.decode(Buffer.from(response.data), 'gbk');
  return parseTencentResponse(rawText);
}

// ─── 带 fallback 的统一股票行情接口 ──────────────────────────

/**
 * 批量获取股票/指数行情，新浪为主源，腾讯为备用
 * - 主源失败自动切换备用源
 * - 备用源数据合并主源缺失条目（部分成功场景）
 * @param {string[]} codes  已含 sh/sz 前缀的代码数组
 * @param {number}   ttl    缓存有效期（ms）
 */
async function fetchStockQuote(codes, ttl = CACHE_TTL) {
  const cacheKey = `stock:${[...codes].sort().join(',')}`;
  const hit = getCached(cacheKey, ttl);
  if (hit) return { ...hit, cached: true };

  // 根据健康状态决定尝试顺序：失败多则降级
  const sinaHealthy    = sourceHealth.sina    < SOURCE_FAIL_THRESHOLD;
  const tencentHealthy = sourceHealth.tencent < SOURCE_FAIL_THRESHOLD;

  // 优先新浪（默认），若新浪已连续失败超阈值则优先腾讯
  const tryOrder = sinaHealthy || !tencentHealthy
    ? ['sina', 'tencent']
    : ['tencent', 'sina'];

  let result = null;
  let lastErr = null;

  for (const source of tryOrder) {
    try {
      if (source === 'sina') {
        result = await fetchStockQuoteSina(codes, ttl);
      } else {
        result = await fetchStockQuoteTencent(codes);
      }
      // 成功：重置该源失败计数
      sourceHealth[source] = 0;
      break;
    } catch (err) {
      sourceHealth[source]++;
      lastErr = err;
      console.warn(`[QuoteService] ${source} 行情拉取失败（连续 ${sourceHealth[source]} 次）: ${err.message}，尝试备用源...`);
    }
  }

  if (!result) {
    // 两个源均失败，尝试返回过期缓存（stale）
    const stale = getStaleCached(cacheKey);
    if (stale) {
      console.warn('[QuoteService] 主备源均失败，返回过期缓存');
      return { ...stale, stale: true };
    }
    throw lastErr || new Error('行情数据拉取失败');
  }

  // 检查结果是否有效（避免缓存空数据）
  if (Object.keys(result).length > 0) {
    setCache(cacheKey, result);
  }
  return result;
}

/**
 * 获取单只基金实时估值（天天基金，无备用源——基金估值唯一权威源）
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
    dwjz:  parseFloat(obj.dwjz)  || 0, // 昨日净值
    gsz:   parseFloat(obj.gsz)   || 0, // 估算净值
    gszzl: parseFloat(obj.gszzl) || 0, // 估算涨跌幅(%)
    gztime: obj.gztime || '',          // 估值时间
  };

  setCache(cacheKey, result);
  return result;
}

// ─── 全球指数 ──────────────────────────────────────────────────

/**
 * 解析全球指数行情字符串（新浪 gb_ 系列）
 * 格式: name, current, change_pct, change_amount, prev_close, ...
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
    const change_pct    = parseFloat(parts[2]) || 0;
    const change_amount = parseFloat(parts[3]) || 0;
    const close         = parseFloat(parts[4]) || 0;

    result[code] = { name, current, close, change_pct, change_amount, isGlobal: true };
  }

  return result;
}

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
  const rawText = iconv.decode(Buffer.from(response.data), 'gbk');
  return parseGlobalResponse(rawText);
}

/**
 * 获取大盘指数（A股6只 + 全球3只）
 * 大盘 A 股部分同样受益于 fetchStockQuote 的 fallback 机制
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