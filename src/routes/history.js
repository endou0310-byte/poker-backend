<<<<<<< HEAD
import express from "express";
import pool from "../db/pool.js";

const router = express.Router();

// ======================
// 1) 履歴一覧
// ======================
router.get("/list", async (req, res) => {
  const user_id = req.query.user_id;

  if (!user_id) {
    return res.status(400).json({ ok: false, error: "missing_user_id" });
  }

  try {
    const q = `
      SELECT
        id,
        hand_id,
        created_at,
        evaluation,
        markdown
      FROM hand_histories
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const result = await pool.query(q, [user_id]);

    return res.json({
      ok: true,
      histories: result.rows   // ← ココだけ修正！
    });
  } catch (err) {
    console.error("/history/list error:", err);
    return res.status(500).json({ ok: false });
  }
});



// ======================
// 2) 詳細取得
// ======================
router.get("/detail", async (req, res) => {
  const id = req.query.id;

  if (!id) {
    return res.status(400).json({ ok: false, error: "missing_id" });
  }

  try {
    const q = `
      SELECT
        id,
        user_id,
        hand_id,
        created_at,
        snapshot,
        evaluation,
        conversation,
        markdown
      FROM hand_histories
      WHERE id = $1
      LIMIT 1
    `;
    const result = await pool.query(q, [id]);

    if (result.rows.length === 0) {
      return res.json({ ok: false, error: "not_found" });
    }

return res.json({
  ok: true,
  histories: result.rows
});

  } catch (err) {
    console.error("/history/detail error:", err);
    return res.status(500).json({ ok: false });
  }
});

export default router;

=======
import express from "express";
import pool from "../db/pool.js";

const router = express.Router();

// ======================
// 1) 履歴一覧
// ======================
router.get("/list", async (req, res) => {
  const user_id = req.query.user_id;

  if (!user_id) {
    return res.status(400).json({ ok: false, error: "missing_user_id" });
  }

  try {
    const q = `
      SELECT
        id,
        hand_id,
        created_at,
        evaluation,
        markdown
      FROM hand_histories
      WHERE user_id = $1
      ORDER BY created_at DESC
    `;
    const result = await pool.query(q, [user_id]);

    return res.json({
      ok: true,
      histories: result.rows   // ← ココだけ修正！
    });
  } catch (err) {
    console.error("/history/list error:", err);
    return res.status(500).json({ ok: false });
  }
});



// ======================
// 2) 詳細取得
// ======================
router.get("/detail", async (req, res) => {
  const id = req.query.id;

  if (!id) {
    return res.status(400).json({ ok: false, error: "missing_id" });
  }

  try {
    const q = `
      SELECT
        id,
        user_id,
        hand_id,
        created_at,
        snapshot,
        evaluation,
        conversation,
        markdown
      FROM hand_histories
      WHERE id = $1
      LIMIT 1
    `;
    const result = await pool.query(q, [id]);

    if (result.rows.length === 0) {
      return res.json({ ok: false, error: "not_found" });
    }

return res.json({
  ok: true,
  histories: result.rows
});

  } catch (err) {
    console.error("/history/detail error:", err);
    return res.status(500).json({ ok: false });
  }
});

export default router;

>>>>>>> 4caa1f9818703744ea7b871432cb98b9ed6cc480
