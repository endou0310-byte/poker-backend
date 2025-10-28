// src/lib/googleAuth.js
const { OAuth2Client } = require('google-auth-library');

const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * 検証に成功すると { email, name } を返す
 * 検証に失敗すると throw する
 */
async function verifyGoogleIdToken(idToken) {
  // 1. トークンをGoogleで検証
  const ticket = await client.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID, 
    // ← サーバー側で許可するクライアントID
  });

  // 2. ペイロード（中身）を取り出す
  const payload = ticket.getPayload();
  // payload の一例:
  // {
  //   "iss": "https://accounts.google.com",
  //   "aud": "xxxxxxxxxxx-abc123.apps.googleusercontent.com",
  //   "sub": "109876543210987654321", // Google側のユーザー固有ID
  //   "email": "player@example.com",
  //   "email_verified": true,
  //   "name": "Poker User",
  //   "picture": "https://lh3.googleusercontent.com/a/....",
  //   "exp": 1730123456,
  //   ...
  // }

  if (!payload) {
    throw new Error('no_payload');
  }

  // 念のため信頼できるかチェック（安全サイド）
  if (!payload.email || !payload.email_verified) {
    throw new Error('unverified_email');
  }

  // 必要な情報だけ返す
  return {
    sub: payload.sub,           // ← Googleユーザー固有ID
    email: payload.email,
    name: payload.name || 'Player',  // display_name用
  };
}

module.exports = {
  verifyGoogleIdToken,
};
