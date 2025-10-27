require('dotenv').config();
const express = require('express');

process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION >>>', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('UNHANDLED REJECTION >>>', reason);
});

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ ok: true, msg: 'debug server up' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log('DEBUG server listening on', PORT);
});
