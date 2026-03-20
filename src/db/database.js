'use strict';

const mysql = require('mysql2/promise');

// ─── 连接池（每个 worker 独立持有）────────────────────────────
const pool = mysql.createPool({
  host:               process.env.MYSQL_HOST     || 'localhost',
  port:               parseInt(process.env.MYSQL_PORT || '3306', 10),
  user:               process.env.MYSQL_USER     || 'root',
  password:           process.env.MYSQL_PASSWORD || '',
  database:           process.env.MYSQL_DATABASE || 'astock',
  waitForConnections: true,
  connectionLimit:    parseInt(process.env.MYSQL_CONN_LIMIT || '10', 10),
  queueLimit:         0,
  charset:            'utf8mb4',
  timezone:           '+08:00',
});

// ─── 建表 DDL ─────────────────────────────────────────────────
async function initDatabase() {
  try {
    // 用户表
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        username        VARCHAR(30)  NOT NULL UNIQUE,
        password_hash   VARCHAR(100) NOT NULL,
        is_vip          TINYINT(1)   NOT NULL DEFAULT 0,
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at   DATETIME     NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 存量数据兼容：若 users 表已存在但缺少 is_vip 列，则动态添加
    try {
      await pool.execute(`ALTER TABLE users ADD COLUMN is_vip TINYINT(1) NOT NULL DEFAULT 0`);
    } catch (e) {
      if (e.errno !== 1060) console.warn('[DB] ALTER users 字段警告:', e.message);
    }

    // 存量数据兼容：添加 token_version 列（用于改密码后使旧 Token 失效）
    try {
      await pool.execute(`ALTER TABLE users ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0`);
    } catch (e) {
      if (e.errno !== 1060) console.warn('[DB] ALTER users 字段警告:', e.message);
    }

    // 持仓表（含 user_id）
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS positions (
        id          INT UNSIGNED         AUTO_INCREMENT PRIMARY KEY,
        user_id     INT UNSIGNED         NOT NULL DEFAULT 0,
        type        ENUM('stock','fund') NOT NULL,
        code        VARCHAR(10)          NOT NULL,
        name        VARCHAR(50)          NOT NULL DEFAULT '',
        shares      DECIMAL(18,4)        NOT NULL,
        cost_price  DECIMAL(18,4)        NOT NULL,
        group_name  VARCHAR(30)          NOT NULL DEFAULT '',
        stop_loss   DECIMAL(18,4)        NULL DEFAULT NULL,
        take_profit DECIMAL(18,4)        NULL DEFAULT NULL,
        created_at  DATETIME             NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_user_id (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    // 存量数据兼容：若 positions 表已存在但缺少 user_id 列，则动态添加
    try {
      await pool.execute(`ALTER TABLE positions ADD COLUMN user_id INT UNSIGNED NOT NULL DEFAULT 0 AFTER id`);
      await pool.execute(`ALTER TABLE positions ADD INDEX idx_user_id (user_id)`);
    } catch (alterErr) {
      // 列已存在（1060）或索引已存在（1061）时忽略
      if (alterErr.errno !== 1060 && alterErr.errno !== 1061) {
        console.warn('[DB] ALTER TABLE positions 警告:', alterErr.message);
      }
    }

    // 存量数据兼容：添加止损/目标价字段
    for (const col of [
      'ALTER TABLE positions ADD COLUMN stop_loss   DECIMAL(18,4) NULL DEFAULT NULL',
      'ALTER TABLE positions ADD COLUMN take_profit DECIMAL(18,4) NULL DEFAULT NULL',
    ]) {
      try { await pool.execute(col); } catch (e) {
        if (e.errno !== 1060) console.warn('[DB] ALTER positions 字段警告:', e.message);
      }
    }

    // 每日收益快照表
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS daily_snapshots (
        id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        user_id       INT UNSIGNED NOT NULL,
        snap_date     DATE         NOT NULL,
        total_asset   DECIMAL(18,2) NOT NULL DEFAULT 0,
        total_cost    DECIMAL(18,2) NOT NULL DEFAULT 0,
        total_profit  DECIMAL(18,2) NOT NULL DEFAULT 0,
        today_profit  DECIMAL(18,2) NOT NULL DEFAULT 0,
        today_pct     DECIMAL(10,4) NOT NULL DEFAULT 0,
        total_pct     DECIMAL(10,4) NOT NULL DEFAULT 0,
        position_count INT UNSIGNED NOT NULL DEFAULT 0,
        created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uk_user_date (user_id, snap_date)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    console.log('✅ 数据库初始化完成');
  } catch (err) {
    console.error('❌ 数据库初始化失败:', err.message);
    process.exit(1);
  }
}

// ─── 用户 CRUD ────────────────────────────────────────────────

/**
 * 创建用户
 * @param {string} username
 * @param {string} passwordHash  bcrypt 哈希后的密码
 * @returns {{ id: number }}
 */
async function createUser(username, passwordHash) {
  const [result] = await pool.execute(
    'INSERT INTO users (username, password_hash) VALUES (?, ?)',
    [username, passwordHash]
  );
  return { id: result.insertId };
}

/**
 * 按用户名查找用户
 * @param {string} username
 * @returns {object|undefined}
 */
async function findUserByUsername(username) {
  const [rows] = await pool.execute(
    'SELECT * FROM users WHERE username = ? LIMIT 1',
    [username]
  );
  return rows[0];
}

/**
 * 更新最后登录时间
 * @param {number} id
 */
async function updateLastLogin(id) {
  await pool.execute(
    'UPDATE users SET last_login_at = NOW() WHERE id = ?',
    [id]
  );
}

// ─── 持仓 CRUD（全异步，均使用预编译语句防 SQL 注入）──────────

/**
 * 获取指定用户的所有持仓，按 group_name、created_at 排序
 * @param {number} userId
 */
async function getAllPositions(userId) {
  const [rows] = await pool.execute(
    'SELECT * FROM positions WHERE user_id = ? ORDER BY group_name, created_at DESC',
    [userId]
  );
  return rows;
}

/**
 * 新增持仓
 * @param {{ type, code, name, shares, cost_price, group_name, userId }} data
 * @returns {{ id: number }}
 */
async function createPosition(data) {
  const [result] = await pool.execute(
    'INSERT INTO positions (user_id, type, code, name, shares, cost_price, group_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [data.userId, data.type, data.code, data.name || '', data.shares, data.cost_price, data.group_name || '']
  );
  return { id: result.insertId };
}

// 字段名白名单，防止原型链污染
const ALLOWED_UPDATE_FIELDS = Object.freeze(['name', 'shares', 'cost_price', 'group_name', 'stop_loss', 'take_profit']);

/**
 * 更新持仓（支持部分字段更新，强制校验 user_id 防越权）
 * @param {number} id
 * @param {{ name?, shares?, cost_price?, group_name? }} data
 * @param {number} userId  当前操作用户 ID
 */
async function updatePosition(id, data, userId) {
  const fields = Object.keys(data).filter((k) => ALLOWED_UPDATE_FIELDS.includes(k));
  if (fields.length === 0) return { changes: 0 };

  const setClause = fields.map((f) => `${f} = ?`).join(', ');
  // userId 参数存在时加 user_id 过滤，防越权；不存在时（内部调用）仅按 id 更新
  const values = userId !== undefined
    ? [...fields.map((f) => data[f]), id, userId]
    : [...fields.map((f) => data[f]), id];
  const whereClause = userId !== undefined ? 'WHERE id = ? AND user_id = ?' : 'WHERE id = ?';

  const [result] = await pool.execute(
    `UPDATE positions SET ${setClause} ${whereClause}`,
    values
  );
  return { changes: result.affectedRows };
}

/**
 * 删除持仓（强制校验 user_id 防越权）
 * @param {number} id
 * @param {number} userId
 */
async function deletePosition(id, userId) {
  const [result] = await pool.execute(
    'DELETE FROM positions WHERE id = ? AND user_id = ?',
    [id, userId]
  );
  return { changes: result.affectedRows };
}

/**
 * 通过 id 查询单条持仓（不限 user_id，供内部使用）
 * @param {number} id
 */
async function getPositionById(id) {
  const [rows] = await pool.execute(
    'SELECT * FROM positions WHERE id = ?',
    [id]
  );
  return rows[0];
}

// ─── 历史每日快照 CRUD ────────────────────────────────────────

/**
 * 写入或更新某天的收益快照（upsert）
 * 规则：
 *   - 今日快照：允许覆盖更新（交易日内可多次刷新）
 *   - 历史快照（非今日）：仅允许首次写入，已有记录则忽略，防止日后操作意外覆盖历史数据
 * @param {number} userId
 * @param {object} snap  { snap_date, total_asset, total_cost, total_profit, today_profit, today_pct, total_pct, position_count }
 */
async function upsertDailySnapshot(userId, snap) {
  const {
    snap_date, total_asset, total_cost, total_profit,
    today_profit, today_pct, total_pct, position_count,
  } = snap;

  // 计算北京时间今日日期
  const now = new Date();
  const bjToday = new Date(now.getTime() + (8 * 60 + now.getTimezoneOffset()) * 60000)
    .toISOString().slice(0, 10);

  if (snap_date === bjToday) {
    // 今日快照：允许覆盖
    await pool.execute(
      `INSERT INTO daily_snapshots
         (user_id, snap_date, total_asset, total_cost, total_profit, today_profit, today_pct, total_pct, position_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         total_asset    = VALUES(total_asset),
         total_cost     = VALUES(total_cost),
         total_profit   = VALUES(total_profit),
         today_profit   = VALUES(today_profit),
         today_pct      = VALUES(today_pct),
         total_pct      = VALUES(total_pct),
         position_count = VALUES(position_count)`,
      [userId, snap_date, total_asset, total_cost, total_profit, today_profit, today_pct, total_pct, position_count]
    );
  } else {
    // 历史快照：仅首次写入，已存在则忽略（INSERT IGNORE）
    await pool.execute(
      `INSERT IGNORE INTO daily_snapshots
         (user_id, snap_date, total_asset, total_cost, total_profit, today_profit, today_pct, total_pct, position_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, snap_date, total_asset, total_cost, total_profit, today_profit, today_pct, total_pct, position_count]
    );
  }
}

/**
 * 查询某用户指定年月范围内的所有快照
 * @param {number} userId
 * @param {string} startDate  'YYYY-MM-DD'
 * @param {string} endDate    'YYYY-MM-DD'
 */
async function getDailySnapshots(userId, startDate, endDate) {
  const [rows] = await pool.execute(
    `SELECT * FROM daily_snapshots
     WHERE user_id = ? AND snap_date BETWEEN ? AND ?
     ORDER BY snap_date ASC`,
    [userId, startDate, endDate]
  );
  return rows;
}

/**
 * 查询某用户某天的快照
 * @param {number} userId
 * @param {string} date  'YYYY-MM-DD'
 */
async function getSnapshotByDate(userId, date) {
  const [rows] = await pool.execute(
    'SELECT * FROM daily_snapshots WHERE user_id = ? AND snap_date = ? LIMIT 1',
    [userId, date]
  );
  return rows[0];
}

/**
 * 按 ID 查找用户（含 is_vip 字段）
 * @param {number} id
 */
async function getUserById(id) {
  const [rows] = await pool.execute(
    'SELECT id, username, is_vip, created_at, last_login_at FROM users WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0];
}

/**
 * 设置用户 VIP 状态（管理员操作）
 * @param {number}  id
 * @param {boolean} isVip
 */
async function setUserVip(id, isVip) {
  await pool.execute(
    'UPDATE users SET is_vip = ? WHERE id = ?',
    [isVip ? 1 : 0, id]
  );
}

/**
 * 查询用户 token_version（用于 JWT 校验）
 * @param {number} id
 * @returns {number}
 */
async function getTokenVersion(id) {
  const [rows] = await pool.execute(
    'SELECT token_version FROM users WHERE id = ? LIMIT 1',
    [id]
  );
  return rows[0] ? (rows[0].token_version || 0) : -1;
}

module.exports = {
  pool,
  initDatabase,
  // 用户相关
  createUser,
  findUserByUsername,
  updateLastLogin,
  getUserById,
  setUserVip,
  getTokenVersion,
  // 持仓相关
  getAllPositions,
  createPosition,
  updatePosition,
  deletePosition,
  getPositionById,
  // 历史快照相关
  upsertDailySnapshot,
  getDailySnapshots,
  getSnapshotByDate,
};