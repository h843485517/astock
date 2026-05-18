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
 * 同时 await 校验 token_version 确保改密码后旧 Token 立即失效
 */
async function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) {
    return res.status(401).json({ code: 1, message: '未登录，请先登录' });
  }
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;

    // 同步 await 校验 token_version，确保改密码后旧 Token 立即失效
    const db = require('../db/database');
    const dbVersion = await db.getTokenVersion(decoded.id);

    if (dbVersion === -1) {
      res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
      return res.status(401).json({ code: 1, message: '用户不存在，请重新登录' });
    }
    if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== dbVersion) {
      res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
      return res.status(401).json({ code: 1, message: '密码已变更，请重新登录' });
    }
    next();
  } catch (err) {
    // JWT 验证失败（过期、签名错误等）
    if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
      res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
      return res.status(401).json({ code: 1, message: 'Token 无效或已过期，请重新登录' });
    }
    // DB 查询等其他错误：返回 500，不放行，避免安全绕过
    console.error('[Auth] token_version 校验失败:', err.message);
    return res.status(500).json({ code: 1, message: '认证服务暂不可用，请稍后重试' });
  }
}

module.exports = { requireAuth, getSecret: () => SECRET };
