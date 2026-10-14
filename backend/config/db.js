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

/**
 * Runs `fn` inside one transaction (Table 4.2, reliability: "transactional
 * updates"). `fn` receives an object with the same query/one interface, bound
 * to the transaction's connection; any throw rolls everything back.
 */
async function transaction(fn) {
  const conn = await getPool().getConnection();
  const tx = {
    query: async (sql, params = []) => { const [rows] = await conn.execute(sql, params); return rows; },
    one: async (sql, params = []) => {
      const rows = await tx.query(sql, params);
      return rows.length ? rows[0] : null;
    },
  };
  try {
    await conn.beginTransaction();
    const out = await fn(tx);
    await conn.commit();
    return out;
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function close() {
  if (pool) { await pool.end(); pool = null; }
}

module.exports = { query, one, transaction, getPool, close };
