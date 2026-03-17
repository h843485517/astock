#!/usr/bin/env node
/**
 * AI 模式本地测试脚本
 * 用法：
 *   node scripts/test-ai.js free    → 测试免费模式（GLM-4-Flash）
 *   node scripts/test-ai.js vip     → 测试 VIP 模式（Ollama）
 *   node scripts/test-ai.js set-vip <用户名>    → 将用户设为 VIP
 *   node scripts/test-ai.js set-free <用户名>   → 将用户设为免费
 *   node scripts/test-ai.js list    → 查看所有用户 VIP 状态
 */

'use strict';
require('dotenv').config();
const axios  = require('axios');
const mysql2 = require('mysql2/promise');

const [,, cmd, arg] = process.argv;

// ── 颜色输出 ──────────────────────────────────────────────────
const c = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
};
const ok   = (s) => console.log(`${c.green}✓${c.reset} ${s}`);
const warn = (s) => console.log(`${c.yellow}⚠${c.reset}  ${s}`);
const err  = (s) => console.log(`${c.red}✗${c.reset} ${s}`);
const info = (s) => console.log(`${c.cyan}ℹ${c.reset} ${s}`);

// ── DB 连接 ───────────────────────────────────────────────────
async function getDB() {
  return mysql2.createConnection({
    host:     process.env.MYSQL_HOST     || 'localhost',
    port:     parseInt(process.env.MYSQL_PORT || '3306'),
    user:     process.env.MYSQL_USER     || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'astock',
  });
}

// ── 查用户列表 ─────────────────────────────────────────────────
async function listUsers() {
  const db = await getDB();
  const [rows] = await db.execute('SELECT id, username, is_vip FROM users ORDER BY id');
  await db.end();
  console.log(`\n${c.bold}当前用户 VIP 状态：${c.reset}`);
  console.log('─'.repeat(40));
  for (const r of rows) {
    const tag = r.is_vip ? `${c.yellow}👑 VIP${c.reset}` : `${c.cyan}🆓 免费${c.reset}`;
    console.log(`  [${r.id}] ${r.username.padEnd(20)} ${tag}`);
  }
  console.log('─'.repeat(40) + '\n');
}

// ── 设置 VIP ──────────────────────────────────────────────────
async function setVip(username, isVip) {
  if (!username) { err('请提供用户名，例如：node scripts/test-ai.js set-vip admin'); process.exit(1); }
  const db = await getDB();
  const [res] = await db.execute('UPDATE users SET is_vip = ? WHERE username = ?', [isVip ? 1 : 0, username]);
  await db.end();
  if (res.affectedRows === 0) {
    err(`用户 "${username}" 不存在`);
  } else {
    ok(`用户 "${username}" 已设为 ${isVip ? '👑 VIP' : '🆓 免费'} 模式`);
  }
}

// ── 测试免费模式（直连智谱 AI）────────────────────────────────
async function testFree() {
  const base  = process.env.OPENAI_API_BASE  || '';
  const key   = process.env.OPENAI_API_KEY   || '';
  const model = process.env.OPENAI_FREE_MODEL || 'GLM-4-Flash-250414';

  console.log(`\n${c.bold}═══ 免费模式测试（OpenAI 兼容 API）═══${c.reset}`);
  info(`接口地址：${base}`);
  info(`模型名称：${model}`);
  info(`API Key ：${key ? key.slice(0, 8) + '...' + key.slice(-4) : '(未配置)'}`);
  console.log('');

  if (!key) {
    err('OPENAI_API_KEY 未配置，请在 .env 中填写！');
    return;
  }

  info('发送测试请求...\n');
  try {
    const response = await axios.post(
      `${base}/chat/completions`,
      {
        model,
        stream: false,
        messages: [
          { role: 'system', content: '你是一个 A 股投资顾问，请简短回答。' },
          { role: 'user',   content: '用一句话解释什么是市盈率（P/E）？' },
        ],
        max_tokens: 200,
      },
      {
        timeout: 30000,
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      }
    );
    const content = response.data?.choices?.[0]?.message?.content || '（无内容）';
    ok('连接成功！AI 回复：');
    console.log(`\n  ${c.cyan}${content}${c.reset}\n`);
  } catch (e) {
    if (e.response) {
      err(`请求失败 HTTP ${e.response.status}：${JSON.stringify(e.response.data)}`);
    } else {
      err(`请求失败：${e.message}`);
    }
  }
}

// ── 测试 VIP 模式（Ollama）────────────────────────────────────
async function testVip() {
  const base  = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  const model = process.env.OLLAMA_MODEL    || 'qwen2.5:3b';

  console.log(`\n${c.bold}═══ VIP 模式测试（Ollama 本地模型）═══${c.reset}`);
  info(`Ollama 地址：${base}`);
  info(`模型名称  ：${model}`);
  console.log('');

  // 先检查 Ollama 是否在运行
  try {
    await axios.get(`${base}/api/tags`, { timeout: 3000 });
    ok('Ollama 服务已启动');
  } catch (_) {
    err(`Ollama 未运行，请先执行：ollama serve`);
    warn(`然后确保已拉取模型：ollama pull ${model}`);
    return;
  }

  info('发送测试请求...\n');
  try {
    const response = await axios.post(
      `${base}/api/chat`,
      {
        model,
        stream: false,
        messages: [
          { role: 'system', content: '你是一个 A 股投资顾问，请简短回答。' },
          { role: 'user',   content: '用一句话解释什么是市盈率（P/E）？' },
        ],
      },
      { timeout: 60000 }
    );
    const content = response.data?.message?.content || '（无内容）';
    ok('连接成功！AI 回复：');
    console.log(`\n  ${c.cyan}${content}${c.reset}\n`);
  } catch (e) {
    if (e.response) {
      err(`请求失败 HTTP ${e.response.status}：${JSON.stringify(e.response.data)}`);
    } else {
      err(`请求失败：${e.message}`);
    }
  }
}

// ── 主入口 ─────────────────────────────────────────────────────
(async () => {
  switch (cmd) {
    case 'free':
      await testFree();
      break;
    case 'vip':
      await testVip();
      break;
    case 'set-vip':
      await setVip(arg, true);
      break;
    case 'set-free':
      await setVip(arg, false);
      break;
    case 'list':
      await listUsers();
      break;
    default:
      console.log(`
${c.bold}AI 模式测试工具${c.reset}

用法：
  ${c.cyan}node scripts/test-ai.js free${c.reset}              测试免费模式（GLM-4-Flash）
  ${c.cyan}node scripts/test-ai.js vip${c.reset}               测试 VIP 模式（Ollama）
  ${c.cyan}node scripts/test-ai.js list${c.reset}              查看所有用户 VIP 状态
  ${c.cyan}node scripts/test-ai.js set-vip <用户名>${c.reset}  将用户升级为 VIP
  ${c.cyan}node scripts/test-ai.js set-free <用户名>${c.reset} 将用户降为免费
      `);
  }
  process.exit(0);
})();
