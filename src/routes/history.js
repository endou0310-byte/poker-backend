const express = require("express");
const router = express.Router();
const pool = require("../db/pool");

// GET /history/list?user_id=xxx
router.get("/list", async (req, res) => {
  const user_id = req.query.user_id;

  if (!user_id) {
    return res.status(400).json({ ok: false, error: "missing_user_id" });
  }

  try {
    const q = `
      SELECT id, hand_id, created_at
      FROM hand_history
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const result = await pool.query(q, [user_id]);

    return res.json({
      ok: true,
      items: result.rows
    });
  } catch (err) {
    console.error("/history/list error:", err);
    return res.status(500).json({ ok: false });
  }
});

// GET /history/detail?id=xxx
router.get("/detail", async (req, res) => {
  const id = req.query.id;

  if (!id) {
    return res.status(400).json({ ok: false, error: "missing_id" });
  }

  try {
    const q = `
      SELECT *
      FROM hand_history
      WHERE id = $1
      LIMIT 1
    `;
    const result = await pool.query(q, [id]);
    const row = result.rows[0];

    if (!row) {
      return res.json({ ok: false, error: "not_found" });
    }

    return res.json({
      ok: true,
      history: row
    });
  } catch (err) {
    console.error("/history/detail error:", err);
    return res.status(500).json({ ok: false });
  }
});

module.exports = router;
