require('dotenv').config();
const express = require('express');
const cors = require('cors'); // ←追加
const app = express();

// ① CORS設定
app.use(
  cors({
    origin: "*", // とりあえず全部許可。あとで絞る。
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ② JSONをパース
app.use(express.json());

// ③ ルータ
const authRouter = require('./src/routes/auth');
const planRouter = require('./src/routes/plan');

app.use('/auth', authRouter);
app.use('/me', planRouter);

// ④ /health もそのまま生かしてOK（あるなら）
app.get('/health', (req, res) => {
  res.json({
    ok: true,
    message: 'server is running',
    time: new Date().toISOString(),
  });
});

// ⑤ 起動
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
