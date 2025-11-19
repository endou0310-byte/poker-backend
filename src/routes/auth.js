// src/routes/auth.js

const express = require('express');
const router = express.Router();

const pool = require('../db/pool');
const { verifyGoogleIdToken } = require('../lib/googleAuth');

// POST /auth/google
router.post('/google', async (req, res) => {
  const client = await pool.connect();

  try {
    const { idToken } = req.body;

    // 1. プロフィール情報を用意する
    let profile;

    if (process.env.DEV_SKIP_GOOGLE_VERIFY === 'true') {
      // 開発用のダミーユーザー
      profile = {
        sub: 'test-google-sub-123',         // Google側の一意なユーザーIDに相当
        email: 'test@example.com',
        name: 'Test User',
      };
      console.log('[DEV MODE] using fake profile', profile);

    } else {
      // 本番・検証用：実際にGoogleのトークンを検証
      profile = await verifyGoogleIdToken(idToken);
      // profile は { sub, email, name } を返す想定
    }

    const { sub, email, name } = profile;

    // 2. DBにユーザーを upsert（既存なら更新 / 無ければ作成）
    //    google_sub で一意にユーザーを特定する
    const upsertQuery = `
      INSERT INTO users (
        id,
        created_at,
        display_name,
        email,
        auth_provider,
        last_active_at,
        google_sub
      )
      VALUES (
        gen_random_uuid(),
        NOW(),
        $1,
        $2,
        'google',
        NOW(),
        $3
      )
      ON CONFLICT (google_sub)
      DO UPDATE SET
        email = EXCLUDED.email,
        display_name = EXCLUDED.display_name,
        last_active_at = NOW()
      RETURNING id, display_name, email;
    `;

    const upsertValues = [
      name || 'Player',
      email,
      sub,
    ];

    const result = await client.query(upsertQuery, upsertValues);
    const userRow = result.rows[0];

    // 3. クライアントに返す
    //    これをアプリ側で保存して /me/plan?user_id=... に渡す
    return res.json({
      ok: true,
      user: {
        id: userRow.id,
        email: userRow.email,
        display_name: userRow.display_name,
      },
      is_new: false,
    });

  } catch (err) {
    console.error('/auth/google error:', err);

    return res.status(500).json({
      ok: false,
      error: 'auth_failed',
    });

  } finally {
    client.release();
  }
});

module.exports = router;
