'use strict';

// Applies pending SQL migrations from server/db/migrations/ in order.
// Usage: npm run migrate   (requires DATABASE_URL)

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

function splitStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter((s) => s.length > 0);
}

async function main() {
  if (!config.db.enabled) {
    console.error('DATABASE_URL is not set. Nothing to migrate (running in memory mode).');
    process.exit(1);
  }
  const conn = await mysql.createConnection({
    uri: config.db.url,
    ssl: config.db.ssl ? { ca: config.db.ca || undefined, rejectUnauthorized: true, minVersion: 'TLSv1.2' } : undefined,
    multipleStatements: false,
    timezone: 'Z',
  });

  await conn.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(255) NOT NULL PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

  const [rows] = await conn.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const dir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    console.log(`applying ${file} ...`);
    await conn.beginTransaction();
    try {
      for (const stmt of splitStatements(sql)) {
        await conn.query(stmt);
      }
      await conn.query('INSERT INTO schema_migrations (name) VALUES (?)', [file]);
      await conn.commit();
      count++;
      console.log(`applied  ${file}`);
    } catch (err) {
      await conn.rollback();
      console.error(`FAILED  ${file}: ${err.message}`);
      await conn.end();
      process.exit(1);
    }
  }
  await conn.end();
  console.log(count === 0 ? 'schema is up to date' : `done: ${count} migration(s) applied`);
}

main().catch((err) => {
  console.error('migration error:', err.message);
  process.exit(1);
});
