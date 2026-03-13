'use strict';

const axios = require('axios');

const OLLAMA_BASE_URL = () => process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL    = () => process.env.OLLAMA_MODEL    || 'qwen2.5:7b';

const SYSTEM_PROMPT = `你是一位专业的A股和基金投资顾问，深度熟悉中国资本市场、A股政策、基金运作机制。
请基于用户提供的持仓情况和行情数据，给出专业、客观、有依据的投资建议。
回答要简洁有重点，适当使用列表和分段。
⚠️ 重要声明：你的建议仅供参考，不构成投资依据，请在每次回答结尾提醒用户注意投资风险，投资须谨慎。`;

/**
 * 获取股票近 N 日历史 K 线数据（新浪财经）
 * @param {string} code  带 sh/sz 前缀的股票代码
 * @param {number} days  天数，默认 30
 * @returns {Promise<Array>}  失败时静默返回空数组
 */
async function fetchStockHistory(code, days = 30) {
  try {
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php`
      + `?symbol=${encodeURIComponent(code)}&scale=240&ma=no&datalen=${days}`;
    const res = await axios.get(url, {
      headers: { Referer: 'http://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    // 返回格式: [{"day":"2025-03-12","open":"...","high":"...","low":"...","close":"...","volume":"..."},...]
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

/**
 * 将持仓、行情、历史数据格式化为中文 Prompt 上下文
 * @param {Array}  positions    持仓列表
 * @param {Object} quotes       以 code 为键的行情对象
 * @param {Object} historiesMap 以 code 为键的历史数据数组（可选）
 * @returns {string}
 */
function buildContext(positions, quotes, historiesMap = {}) {
  if (!positions || positions.length === 0) {
    return '【持仓信息】用户暂无持仓，请提供通用的A股/基金投资建议。';
  }

  const lines = ['【用户当前持仓及今日行情】'];
  for (const p of positions) {
    const q       = quotes[p.code] || {};
    const current = q.current    != null ? q.current.toFixed(4)    : '--';
    const pct     = q.change_pct != null ? q.change_pct.toFixed(2) : '--';
    const profit  = (q.current && p.cost_price)
      ? ((q.current - p.cost_price) * p.shares).toFixed(2)
      : '--';
    const typeLabel = p.type === 'fund' ? '基金' : '股票';
    lines.push(
      `- ${p.name || p.code}（${typeLabel} ${p.code}）：` +
      `持有 ${p.shares} 股/份，成本价 ${p.cost_price}，` +
      `当前价 ${current}，今日涨跌 ${pct}%，持有收益 ${profit} 元`
    );

    // 附上近期历史走势摘要（最近 5 日收盘价）
    const hist = historiesMap[p.code];
    if (Array.isArray(hist) && hist.length > 0) {
      const recent = hist.slice(-5).map(h => `${h.day} 收${parseFloat(h.close).toFixed(2)}`).join('、');
      lines.push(`  近5日收盘：${recent}`);
    }
  }

  return lines.join('\n');
}

/**
 * 调用 Ollama 流式 chat 接口，将 token 逐行写入 SSE 响应
 * @param {string}          userMessage  用户问题（已截断至 500 字）
 * @param {string}          context      持仓上下文字符串
 * @param {object}          res          Express Response 对象（已设置 SSE 响应头）
 */
async function streamChat(userMessage, context, res) {
  function sseWrite(str) {
    res.write(str);
    if (typeof res.flush === 'function') res.flush();
  }

  try {
    const response = await axios.post(
      `${OLLAMA_BASE_URL()}/api/chat`,
      {
        model:    OLLAMA_MODEL(),
        stream:   true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: `${context}\n\n用户问题：${userMessage}` },
        ],
      },
      { responseType: 'stream', timeout: 120000 }
    );

    response.data.on('data', (chunk) => {
      const lines = chunk.toString().split('\n').filter(Boolean);
      for (const line of lines) {
        try {
          const obj   = JSON.parse(line);
          const token = obj?.message?.content || '';
          if (token) sseWrite(`data: ${JSON.stringify({ token })}\n\n`);
          if (obj.done) sseWrite('data: [DONE]\n\n');
        } catch (_) {}
      }
    });

    response.data.on('end', () => {
      sseWrite('data: [DONE]\n\n');
      res.end();
    });

    response.data.on('error', (err) => {
      console.error('[ChatService] stream error:', err.message);
      sseWrite(`data: ${JSON.stringify({ error: 'STREAM_ERROR', message: err.message })}\n\n`);
      res.end();
    });

  } catch (err) {
    // Ollama 不可达（ECONNREFUSED / timeout）
    const isUnavailable = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    if (isUnavailable) {
      sseWrite(`data: ${JSON.stringify({ error: 'OLLAMA_NOT_AVAILABLE' })}\n\n`);
    } else {
      sseWrite(`data: ${JSON.stringify({ error: 'CHAT_ERROR', message: err.message })}\n\n`);
    }
    res.end();
  }
}

module.exports = { fetchStockHistory, buildContext, streamChat };