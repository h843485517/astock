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
 * 同时校验 token_version 确保改密码后旧 Token 失效
 */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies.token;
  if (!token) {
    return res.status(401).json({ code: 1, message: '未登录，请先登录' });
  }
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;

    // 异步校验 token_version（不阻塞响应，但若版本不匹配则返回 401）
    const db = require('../db/database');
    db.getTokenVersion(decoded.id).then((dbVersion) => {
      if (dbVersion === -1) {
        // 用户不存在
        res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
        return res.status(401).json({ code: 1, message: '用户不存在，请重新登录' });
      }
      if (decoded.tokenVersion !== undefined && decoded.tokenVersion !== dbVersion) {
        res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
        return res.status(401).json({ code: 1, message: '密码已变更，请重新登录' });
      }
      next();
    }).catch(() => {
      // DB 查询失败时放行（降级：不因 DB 故障阻塞所有请求）
      next();
    });
  } catch (_) {
    res.clearCookie('token', { httpOnly: true, sameSite: 'strict' });
    return res.status(401).json({ code: 1, message: 'Token 无效或已过期，请重新登录' });
  }
}

module.exports = { requireAuth, getSecret: () => SECRET };