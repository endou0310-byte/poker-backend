require('dotenv').config();
const express = require('express');
const app = express();

app.use(express.json()); // ← 全体でJSONボディを受ける

const authRouter = require('./src/routes/auth');
app.use('/auth', authRouter);

const planRouter = require('./src/routes/plan');
app.use('/me', planRouter);

// /health などはそのまま
// listenはそのまま
