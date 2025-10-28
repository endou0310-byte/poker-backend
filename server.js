// --- サーバー起動準備 ---
require('dotenv').config();
const express = require('express');
const app = express();

// JSONボディを受け取れるようにする
app.use(express.json());

// エラーログ（落ちた理由が見えるように）
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

// ルーター読み込み
const authRouter = require('./src/routes/auth');
app.use('/auth', authRouter);

const planRouter = require('./src/routes/plan');
app.use('/me', planRouter);

// ヘルスチェック用（確認用のGET）
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'server is running',
    time: new Date().toISOString(),
  });
});

// ポートを開く
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
