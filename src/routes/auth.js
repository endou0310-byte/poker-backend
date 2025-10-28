// src/routes/auth.js
const express = require('express');
const router = express.Router();
const pool = require('../db/pool');
const { verifyGoogleIdToken } = require('../lib/googleAuth');

// POST /auth/google
router.post('/google', async (req, res) => {
  try {
    const { id_token } = req.body;
    if (!id_token) {
      return res.status(400).json({
        ok: false,
        error: 'missing_id_token'
      });
    }

    // 1. Googleトークン検証
    const { sub, email, name } = await verifyGoogleIdToken(id_token);

    // 2. DBでユーザーを探す or 作る
    const client = await pool.connect();
    let userRow;
    let isNew = false;

    try {
      // 既存ユーザーを google_sub で探す
      const existing = await client.query(
        `SELECT id, display_name, email
         FROM users
         WHERE google_sub = $1
         LIMIT 1`,
        [sub]
      );

      if (existing.rows.length > 0) {
        // 既存あり
        userRow = existing.rows[0];

        // 最終ログイン時刻と名前/メールを更新（念のため最新に）
        await client.query(
          `UPDATE users
             SET last_active_at = NOW(),
                 email = $2,
                 display_name = $3
           WHERE id = $1`,
          [userRow.id, email, name || 'Player']
        );

      } else {
        // 新規作成
        const inserted = await client.query(
          `INSERT INTO users (
             id,
             created_at,
             display_name,
             email,
             auth_provider,
             google_sub,
             last_active_at
           )
           VALUES (
             gen_random_uuid(),
             NOW(),
             $1,     -- display_name
             $2,     -- email
             'google',
             $3,     -- google_sub
             NOW()
           )
           RETURNING id, display_name, email`,
          [name || 'Player', email, sub]
        );

        userRow = inserted.rows[0];
        isNew = true;
      }
    } finally {
      client.release();
    }

    // 3. クライアントに返却
    return res.json({
      ok: true,
      user_id: userRow.id,               // ← アプリ側が保存して使うやつ
      email: userRow.email,
      display_name: userRow.display_name,
      is_new: isNew
    });

  } catch (err) {
    console.error('/auth/google error:', err);
    return res.status(500).json({
      ok: false,
      error: 'server_error'
    });
  }
});

module.exports = router;
