/**
 * MySQL access. Every query in the application goes through `query()`, which
 * keeps parameter binding in one place (so nothing is ever string-concatenated
 * into SQL) and gives the tests a single seam to stub.
 */
const mysql = require('mysql2/promise');

let pool = null;

function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'mzazi',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'mzazi_care',
      waitForConnections: true,
      connectionLimit: Number(process.env.DB_POOL || 10),
      charset: 'utf8mb4',
      timezone: 'Z',
    });
  }
  return pool;
}

/** Parameterised query. Never interpolate user input into `sql`. */
async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** Single row, or null. */
async function one(sql, params = []) {
  const rows = await query(sql, params);
  return rows.length ? rows[0] : null;
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, one, getPool, close };
