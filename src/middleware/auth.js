'use strict';

const jwt = require('jsonwebtoken');

// JWT 密钥：未配置时使用临时随机串（重启后失效），并打印安全警告
let SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  SECRET = require('crypto').randomBytes(64).toString('hex');
  console.warn('⚠️  [Auth] JWT_SECRET 未配置，使用临时随机密钥（服务重启后所有 Token 失效）。');
  console.warn('⚠️  [Auth] 请在 .env 中配置持久化的 JWT_SECRET。');
}

/**
 * Express 中间件：校验 HttpOnly Cookie 中的 JWT
 * 验证通过后将解析结果挂到 req.user = { id, username }
 */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) {
    return res.status(401).json({ code: 1, message: '未登录，请先登录' });
  }
  try {
    req.user = jwt.verify(token, SECRET);
    next();
  } catch (_) {
    res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
    return res.status(401).json({ code: 1, message: 'Token 无效或已过期，请重新登录' });
  }
}

module.exports = { requireAuth, getSecret: () => SECRET };