const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

function getMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
  return { start, end };
}

router.get('/plan', async (req, res) => {
  const userId = req.query.user_id;

  if (!userId) {
    return res.status(400).json({
      ok: false,
      error: 'missing_user_id'
    });
  }

  try {
    // 1. サブスク情報を取得
    const subRes = await pool.query(
      `SELECT plan, status, limit_per_month
         FROM subscriptions
        WHERE user_id = $1
          AND status = 'active'
        ORDER BY started_at DESC
        LIMIT 1`,
      [userId]
    );

    // デフォルト（＝freeユーザー）扱い
    let plan = 'free';
    let status = 'active';
    let limitPerMonth = 3;

    if (subRes.rowCount > 0) {
      plan = subRes.rows[0].plan;
      status = subRes.rows[0].status;
      limitPerMonth = subRes.rows[0].limit_per_month ?? null;
    }

    // 2. 今月の解析回数
    const { start, end } = getMonthRange();
    const usageRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt
         FROM usage_logs
        WHERE user_id = $1
          AND action_type = 'analyze'
          AND created_at >= $2
          AND created_at < $3`,
      [userId, start, end]
    );
    const usedThisMonth = usageRes.rows[0].cnt;

    // 3. 残り回数
    let remaining = null;
    if (limitPerMonth !== null && limitPerMonth !== undefined) {
      remaining = limitPerMonth - usedThisMonth;
    }

    // 4. 権限フラグ
    const can_followup = (plan !== 'free');
    const ads_enabled = (plan === 'free');

    // 5. 応答
    return res.json({
      ok: true,
      user_id: userId,
      plan,
      status,
      limit_per_month: limitPerMonth,
      used_this_month: usedThisMonth,
      remaining_this_month: remaining,
      can_followup,
      ads_enabled
    });

  } catch (err) {
    console.error('GET /me/plan error:', err);
    return res.status(500).json({
      ok: false,
      error: 'server_error'
    });
  }
});

module.exports = router;
