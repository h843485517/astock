'use strict';

// 加载 .env 文件中的环境变量（生产环境可通过系统环境变量覆盖）
require('dotenv').config();

const cluster = require('cluster');
const os      = require('os');

// ─── cluster 主进程：生产环境多核启动 ──────────────────────────
const IS_DEV = process.env.NODE_ENV === 'development';

if (cluster.isPrimary && !IS_DEV) {
  const numWorkers = os.cpus().length;
  console.log(`[Cluster] 主进程 ${process.pid} 启动，fork ${numWorkers} 个 worker`);

  for (let i = 0; i < numWorkers; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    console.warn(`[Cluster] worker ${worker.process.pid} 退出 (code=${code}, signal=${signal})，正在重启...`);
    cluster.fork();
  });

  return; // 主进程不执行 HTTP 逻辑
}

const express   = require('express');
const path      = require('path');
const helmet    = require('helmet');
const compress  = require('compression');
const rateLimit = require('express-rate-limit');

const cookieParser               = require('cookie-parser');
const positionsRouter            = require('./src/routes/positions');
const quoteRouter                = require('./src/routes/quote');
const authRouter                 = require('./src/routes/auth');
const chatRouter                 = require('./src/routes/chat');
const { startIndexPolling }      = require('./src/services/quoteService');
const { initDatabase, pool }     = require('./src/db/database');

const SSE_INTERVAL_MS = parseInt(process.env.SSE_INTERVAL_MS || '10000', 10);

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── 安全头 & 压缩 ────────────────────────────────────────────
// 根据部署协议决定安全策略：HTTPS 环境启用完整 CSP，HTTP 环境禁用强制升级
const isHttpsDeployment = process.env.HTTPS_ENABLED === 'true';
app.use(helmet({
  contentSecurityPolicy: isHttpsDeployment ? {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'unpkg.com', 'cdn.jsdelivr.net'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'unpkg.com', 'cdn.jsdelivr.net', 'fonts.googleapis.com'],
      fontSrc:     ["'self'", 'fonts.gstatic.com', 'data:'],
      imgSrc:      ["'self'", 'data:'],
      connectSrc:  ["'self'"],
    },
  } : false, // HTTP 环境下禁用 CSP（避免 upgrade-insecure-requests）
  strictTransportSecurity: isHttpsDeployment, // 仅 HTTPS 环境启用 HSTS
}));

// SSE 路由跳过压缩，避免 compression 缓冲导致数据无法实时推送
const SSE_PATHS = ['/api/market-index/stream', '/api/positions/stream', '/api/chat/stream'];
app.use(compress({
  filter: (req, res) => {
    if (SSE_PATHS.some(p => req.path.startsWith(p))) return false;
    return compress.filter(req, res);
  },
}));

// ─── API 限流（15 分钟内最多 300 次）────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: parseInt(process.env.RATE_LIMIT_API_MAX || '300', 10),
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ code: 1, message: '请求过于频繁，请稍后再试' }),
});
app.use('/api', apiLimiter);

// ─── 中间件（含请求体大小限制，防超大请求攻击）────────────────
app.use(cookieParser());
const REQUEST_BODY_LIMIT = process.env.REQUEST_BODY_LIMIT || '100kb';
app.use(express.json({ limit: REQUEST_BODY_LIMIT }));
app.use(express.urlencoded({ extended: false, limit: REQUEST_BODY_LIMIT }));

// ─── API 路由 ─────────────────────────────────────────────────
app.use('/api/auth',      authRouter);
app.use('/api/positions', positionsRouter);
app.use('/api/chat',      chatRouter);
app.use('/api', quoteRouter);

// ─── 静态文件（生产用 dist/，开发由 Vite 托管）────────────────
const staticDir = path.join(__dirname, 'dist');
const fs = require('fs');
if (fs.existsSync(staticDir)) {
  app.use(express.static(staticDir));
  app.get(/^(?!\/api).*$/, (req, res) => {
    res.sendFile(path.join(staticDir, 'index.html'));
  });
} else {
  // 开发模式兜底：仍可访问旧 public/（向后兼容）
  app.use(express.static(path.join(__dirname, 'public')));
  app.get(/^(?!\/api).*$/, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
}

// ─── 统一错误处理中间件 ────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ code: 1, message: '请求体超出大小限制（最大 100KB）' });
  }
  console.error('[Server Error]', err.stack || err.message);
  res.status(500).json({ code: 1, message: 'Internal Server Error' });
});

// ─── 释放被占用的端口 ─────────────────────────────────────────
function killPort(port) {
  return new Promise((resolve) => {
    const { exec } = require('child_process');
    exec(`lsof -ti:${port}`, (err, stdout) => {
      if (err || !stdout.trim()) return resolve(); // 没有进程占用
      const pids = stdout.trim().split('\n').filter(p => p !== String(process.pid));
      if (pids.length === 0) return resolve();
      console.warn(`⚠️  端口 ${port} 被占用 (PID: ${pids.join(',')}), 正在释放...`);
      exec(`kill -9 ${pids.join(' ')}`, () => {
        setTimeout(resolve, 500); // 等待端口释放
      });
    });
  });
}

// ─── 启动服务（先释放端口 → 初始化数据库 → 监听）──────────────
let server;
(async () => {
  // Docker 容器环境跳过端i容器启动时端口始终可用）
  if (!process.env.DOCKER_ENV) {
    await killPort(PORT);
  }
  await initDatabase();
  server = app.listen(PORT, () => {
    console.log(`✅ A股收益追踪器已启动：http://localhost:${PORT}`);
    startIndexPolling(SSE_INTERVAL_MS);
  });
})();

// ─── 优雅关机 ─────────────────────────────────────────────────
function gracefulShutdown(signal) {
  console.log(`[${signal}] 收到退出信号，正在优雅关机...`);
  const httpClose = server ? new Promise((resolve) => server.close(resolve)) : Promise.resolve();
  httpClose.then(async () => {
    console.log('HTTP 服务已关闭');
    try { await pool.end(); console.log('MySQL 连接池已关闭'); } catch (_) {}
    process.exit(0);
  });
  setTimeout(() => { console.error('关机超时，强制退出'); process.exit(1); }, 10000);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// ─── 未捕获异常兜底 ───────────────────────────────────────────
process.on('uncaughtException',  (err)    => console.error('[uncaughtException]',  err));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));

module.exports = app;