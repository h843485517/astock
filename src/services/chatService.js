'use strict';

const axios = require('axios');

// ─── Ollama（VIP / 本地高级模型）──────────────────────────────
const OLLAMA_BASE_URL = () => process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_MODEL    = () => process.env.OLLAMA_MODEL    || 'qwen2.5:3b';

// ─── 免费 API 模式（OpenAI 兼容接口，如 SiliconFlow / DeepSeek）──
// OPENAI_API_BASE  : 接口基础 URL，默认 SiliconFlow
// OPENAI_API_KEY   : API Key（必填，否则免费模式不可用）
// OPENAI_FREE_MODEL: 免费模式使用的模型名
const FREE_API_BASE  = () => process.env.OPENAI_API_BASE  || 'https://api.siliconflow.cn/v1';
const FREE_API_KEY   = () => process.env.OPENAI_API_KEY   || '';
const FREE_API_MODEL = () => process.env.OPENAI_FREE_MODEL || 'Qwen/Qwen2.5-7B-Instruct';

const SYSTEM_PROMPT = `你是一位专业的A股和基金投资顾问，深度熟悉中国资本市场、A股政策、基金运作机制。
请基于用户提供的持仓情况和行情数据，给出专业、客观、有依据的投资建议。
回答要简洁有重点，适当使用列表和分段。
⚠️ 重要声明：你的建议仅供参考，不构成投资依据，请在每次回答结尾提醒用户注意投资风险，投资须谨慎。`;

/**
 * 获取股票近 N 日历史 K 线数据（新浪财经）
 */
async function fetchStockHistory(code, days = 30) {
  try {
    const url = `https://money.finance.sina.com.cn/quotes_service/api/json_v2.php`
      + `?symbol=${encodeURIComponent(code)}&scale=240&ma=no&datalen=${days}`;
    const res = await axios.get(url, {
      headers: { Referer: 'http://finance.sina.com.cn', 'User-Agent': 'Mozilla/5.0' },
      timeout: 8000,
    });
    const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

/**
 * 将持仓、行情、历史数据格式化为中文 Prompt 上下文
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
    const hist = historiesMap[p.code];
    if (Array.isArray(hist) && hist.length > 0) {
      const recent = hist.slice(-5).map(h => `${h.day} 收${parseFloat(h.close).toFixed(2)}`).join('、');
      lines.push(`  近5日收盘：${recent}`);
    }
  }
  return lines.join('\n');
}

/**
 * 构建统一的消息列表（两种模式共用）
 */
function buildMessages(userMessage, context, history = []) {
  const messages = [{ role: 'system', content: SYSTEM_PROMPT }];

  if (history.length > 0) {
    const firstUserMsg = history[0];
    const rest = history.slice(1);
    messages.push(
      { role: firstUserMsg.role, content: `${context}\n\n用户问题：${firstUserMsg.content}` },
      ...rest,
      { role: 'user', content: userMessage },
    );
  } else {
    messages.push({ role: 'user', content: `${context}\n\n用户问题：${userMessage}` });
  }

  return messages;
}

// ─── 免费模式：OpenAI 兼容流式 API ──────────────────────────────

/**
 * 通过 OpenAI 兼容接口（SiliconFlow 等）流式对话
 * @param {string} userMessage
 * @param {string} context
 * @param {object} res        Express Response（已设 SSE 头）
 * @param {Array}  history
 */
async function streamChatFree(userMessage, context, res, history = []) {
  function sseWrite(str) {
    res.write(str);
    if (typeof res.flush === 'function') res.flush();
  }

  const apiKey = FREE_API_KEY();
  if (!apiKey) {
    sseWrite(`data: ${JSON.stringify({ error: 'FREE_API_NO_KEY' })}\n\n`);
    res.end();
    return;
  }

  const messages = buildMessages(userMessage, context, history);

  try {
    const response = await axios.post(
      `${FREE_API_BASE()}/chat/completions`,
      {
        model:  FREE_API_MODEL(),
        stream: true,
        messages,
        max_tokens: 2048,
      },
      {
        responseType: 'stream',
        timeout: 120000,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    let buffer = '';
    response.data.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n');
      buffer = parts.pop(); // 保留未完整的行
      for (const part of parts) {
        const line = part.trim();
        if (!line || !line.startsWith('data:')) continue;
        const jsonStr = line.slice(5).trim();
        if (jsonStr === '[DONE]') {
          sseWrite('data: [DONE]\n\n');
          return;
        }
        try {
          const obj   = JSON.parse(jsonStr);
          const token = obj?.choices?.[0]?.delta?.content || '';
          if (token) sseWrite(`data: ${JSON.stringify({ token })}\n\n`);
        } catch (_) {}
      }
    });

    response.data.on('end', () => {
      sseWrite('data: [DONE]\n\n');
      res.end();
    });

    response.data.on('error', (err) => {
      console.error('[ChatService/Free] stream error:', err.message);
      sseWrite(`data: ${JSON.stringify({ error: 'STREAM_ERROR', message: err.message })}\n\n`);
      res.end();
    });

  } catch (err) {
    console.error('[ChatService/Free] request error:', err.message);
    const isUnavailable = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    if (isUnavailable) {
      sseWrite(`data: ${JSON.stringify({ error: 'FREE_API_UNAVAILABLE' })}\n\n`);
    } else if (err.response?.status === 401) {
      sseWrite(`data: ${JSON.stringify({ error: 'FREE_API_AUTH_FAIL' })}\n\n`);
    } else {
      sseWrite(`data: ${JSON.stringify({ error: 'CHAT_ERROR', message: err.message })}\n\n`);
    }
    res.end();
  }
}

// ─── VIP 模式：Ollama 本地高级模型 ───────────────────────────────

/**
 * 通过 Ollama 流式对话（VIP 专属）
 */
async function streamChatVip(userMessage, context, res, history = []) {
  function sseWrite(str) {
    res.write(str);
    if (typeof res.flush === 'function') res.flush();
  }

  const messages = buildMessages(userMessage, context, history);

  try {
    const response = await axios.post(
      `${OLLAMA_BASE_URL()}/api/chat`,
      {
        model:    OLLAMA_MODEL(),
        stream:   true,
        messages,
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
      console.error('[ChatService/VIP] stream error:', err.message);
      sseWrite(`data: ${JSON.stringify({ error: 'STREAM_ERROR', message: err.message })}\n\n`);
      res.end();
    });

  } catch (err) {
    const isUnavailable = err.code === 'ECONNREFUSED' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
    if (isUnavailable) {
      sseWrite(`data: ${JSON.stringify({ error: 'OLLAMA_NOT_AVAILABLE' })}\n\n`);
    } else {
      sseWrite(`data: ${JSON.stringify({ error: 'CHAT_ERROR', message: err.message })}\n\n`);
    }
    res.end();
  }
}

/**
 * 统一对话入口：根据 isVip 自动路由
 * @param {string}  userMessage
 * @param {string}  context
 * @param {object}  res
 * @param {Array}   history
 * @param {boolean} isVip  是否为 VIP 用户
 */
async function streamChat(userMessage, context, res, history = [], isVip = false) {
  if (isVip) {
    return streamChatVip(userMessage, context, res, history);
  }
  return streamChatFree(userMessage, context, res, history);
}

module.exports = { fetchStockHistory, buildContext, streamChat };