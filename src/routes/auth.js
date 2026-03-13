'use strict';

const express   = require('express');
const bcrypt    = require('bcrypt');
const jwt       = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const router    = express.Router();
const db        = require('../db/database');
const { getSecret } = require('../middleware/auth');

const BCRYPT_ROUNDS    = parseInt(process.env.BCRYPT_ROUNDS    || '12', 10);
const EXPIRES_IN       = process.env.JWT_EXPIRES_IN || '7d';
const COOKIE_MAX_AGE_MS = parseInt(process.env.COOKIE_MAX_AGE_MS || '604800000', 10);

const ok   = (res, data)             => res.json({ code: 0, data });
const fail = (res, message, status = 400) => res.status(status).json({ code: 1, message });

// 登录专用限流：同 IP 5 分钟内最多 RATE_LIMIT_LOGIN_MAX 次，超出锁定 15 分钟
const loginLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_LOGIN_MAX || '10', 10),
  skipSuccessfulRequests: true,       // 成功登录不计入次数
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ code: 1, message: '登录尝试过于频繁，请 15 分钟后再试' }),
});

// 注册限流：同 IP 1 小时内最多 RATE_LIMIT_REGISTER_MAX 次
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_REGISTER_MAX || '5', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ code: 1, message: '注册过于频繁，请稍后再试' }),
});

/**
 * 密码强度校验：≥8 位，含大写字母、小写字母、数字
 */
function validatePassword(password) {
  if (typeof password !== 'string') return '密码格式不正确';
  if (password.length < 8)          return '密码至少需要 8 位';
  if (!/[A-Z]/.test(password))      return '密码需包含至少一个大写字母';
  if (!/[a-z]/.test(password))      return '密码需包含至少一个小写字母';
  if (!/[0-9]/.test(password))      return '密码需包含至少一个数字';
  return null;
}

/**
 * 用户名校验：3-20 位，字母/数字/下划线
 */
function validateUsername(username) {
  if (typeof username !== 'string')       return '用户名格式不正确';
  if (username.length < 3)                return '用户名至少需要 3 位';
  if (username.length > 20)               return '用户名不能超过 20 位';
  if (!/^[a-zA-Z0-9_]+$/.test(username)) return '用户名只能包含字母、数字和下划线';
  return null;
}

// POST /api/auth/register
router.post('/register', registerLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  const uErr = validateUsername(username);
  if (uErr) return fail(res, uErr);

  const pErr = validatePassword(password);
  if (pErr) return fail(res, pErr);

  try {
    const existing = await db.findUserByUsername(username);
    if (existing) return fail(res, '用户名已被占用', 409);

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { id } = await db.createUser(username, passwordHash);

    const token = jwt.sign({ id, username }, getSecret(), { expiresIn: EXPIRES_IN });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS,
    });
    ok(res, { username });
  } catch (err) {
    console.error('[Auth] 注册失败:', err.message);
    fail(res, '注册失败，请稍后重试', 500);
  }
});

// POST /api/auth/login
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) return fail(res, '请填写用户名和密码');

  try {
    const user = await db.findUserByUsername(username);
    // 无论用户是否存在都执行 compare，防时序攻击
    const dummyHash = '$2b$12$invalidhashfortimingnormalization000000000000000000000';
    const valid = user
      ? await bcrypt.compare(password, user.password_hash)
      : await bcrypt.compare(password, dummyHash).then(() => false);

    if (!valid) return fail(res, '用户名或密码错误', 401);

    // 异步更新最后登录时间，不阻塞响应
    db.updateLastLogin(user.id).catch(() => {});

    const token = jwt.sign({ id: user.id, username: user.username }, getSecret(), { expiresIn: EXPIRES_IN });
    res.cookie('token', token, {
      httpOnly: true,
      sameSite: 'strict',
      secure: process.env.NODE_ENV === 'production',
      maxAge: COOKIE_MAX_AGE_MS,
    });
    ok(res, { username: user.username });
  } catch (err) {
    console.error('[Auth] 登录失败:', err.message);
    fail(res, '登录失败，请稍后重试', 500);
  }
});

// PUT /api/auth/password  （需登录）
router.put('/password', require('../middleware/auth').requireAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (!oldPassword || !newPassword) return fail(res, '请填写原密码和新密码');

  const pErr = validatePassword(newPassword);
  if (pErr) return fail(res, pErr);

  try {
    const user = await db.findUserByUsername(req.user.username);
    if (!user) return fail(res, '用户不存在', 404);

    const valid = await bcrypt.compare(oldPassword, user.password_hash);
    if (!valid) return fail(res, '原密码错误', 401);

    const newHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    await db.pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [newHash, user.id]);
    ok(res, null);
  } catch (err) {
    console.error('[Auth] 修改密码失败:', err.message);
    fail(res, '修改密码失败，请稍后重试', 500);
  }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
  res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
  ok(res, null);
});

// GET /api/auth/me
router.get('/me', (req, res) => {
  const token = req.cookies && req.cookies.token;
  if (!token) return fail(res, '未登录', 401);
  try {
    const user = jwt.verify(token, getSecret());
    ok(res, { id: user.id, username: user.username });
  } catch (_) {
    res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
    fail(res, '未登录或登录已过期', 401);
  }
});

module.exports = router;