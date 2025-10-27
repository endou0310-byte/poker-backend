require('dotenv').config();
const express = require('express');
const app = express();

// エラーハンドラ（落ちた理由を見る用）
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION:', reason);
});

app.use(express.json());

// テスト用
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'server is running',
    time: new Date().toISOString()
  });
});

// planルーターはまだ一旦コメントアウト
// const planRouter = require('./src/routes/plan');
// app.use('/me', planRouter);

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
