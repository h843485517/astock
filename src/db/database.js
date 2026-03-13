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
        created_at      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at   DATETIME     NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

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
const ALLOWED_UPDATE_FIELDS = Object.freeze(['name', 'shares', 'cost_price', 'group_name']);

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

module.exports = {
  pool,
  initDatabase,
  // 用户相关
  createUser,
  findUserByUsername,
  updateLastLogin,
  // 持仓相关
  getAllPositions,
  createPosition,
  updatePosition,
  deletePosition,
  getPositionById,
};