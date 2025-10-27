require('dotenv').config();
const pool = require('./src/db/pool');

(async () => {
  try {
    const result = await pool.query('SELECT NOW() AS server_time');
    console.log(result.rows[0]);
    process.exit(0);
  } catch (err) {
    console.error('DB error:', err);
    process.exit(1);
  }
})();
