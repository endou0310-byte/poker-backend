// src/db/pool.js
const { Pool } = require('pg');

// Railwayでもローカルでも、.env か Railway Variables から拾ってくる
// .env に DATABASE_URL=postgresql://ユーザー名:パスワード@ホスト:5432/DB名
// って入ってるやつ（Neonの接続文字列）
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false, // ← Neon/Railway間でSSL必須なので基本trueにできない
  },
});

module.exports = pool;
