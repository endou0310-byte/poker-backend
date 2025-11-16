const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// プランごとのデフォルト設定
// - limit_per_month: null の場合は「月間無制限」
// - followups_per_hand: null の場合は「1ハンドあたり無制限」
const PLAN_CONFIG = {
  free: {
    limit_per_month: 3,
    followups_per_hand: 1,
    ads_enabled: true,
  },
  basic: {
    limit_per_month: 30,
    followups_per_hand: 3,
    ads_enabled: false,
  },
  pro: {
    limit_per_month: 100,
    followups_per_hand: 10,
    ads_enabled: false,
  },
  premium: {
    limit_per_month: null,        // 無制限
    followups_per_hand: null,     // 無制限
    ads_enabled: false,
  },
};

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
      error: 'missing_user_id',
    });
  }

  try {
    // 1. サブスク情報を取得（最新の active を1件）
    const subRes = await pool.query(
      `SELECT plan, status, limit_per_month, store, started_at, expires_at
         FROM subscriptions
        WHERE user_id = $1
          AND status = 'active'
        ORDER BY started_at DESC
        LIMIT 1`,
      [userId]
    );

    // デフォルト（＝freeユーザー）扱い
    let plan = 'free';
    let status = 'none';
    let limitPerMonthOverride = null;
    let store = null;
    let startedAt = null;
    let expiresAt = null;

    if (subRes.rowCount > 0) {
      const row = subRes.rows[0];
      plan = row.plan || 'free';
      status = row.status || 'active';
      limitPerMonthOverride =
        row.limit_per_month !== undefined ? row.limit_per_month : null;
      store = row.store ?? null;
      startedAt = row.started_at ?? null;
      expiresAt = row.expires_at ?? null;
    }

    // プラン定義を取得（未知のプランは free として扱う）
    const planConfig = PLAN_CONFIG[plan] || PLAN_CONFIG.free;
    const baseLimitPerMonth = planConfig.limit_per_month;         // number | null
    const followupsPerHand = planConfig.followups_per_hand;       // number | null
    const adsEnabled = !!planConfig.ads_enabled;

    // subscriptions.limit_per_month が入っていればそれを優先
    let effectiveLimitPerMonth =
      limitPerMonthOverride !== null && limitPerMonthOverride !== undefined
        ? limitPerMonthOverride
        : baseLimitPerMonth;

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

    // 3. 残り回数（無制限プランは null を返す）
    let remaining = null;
    if (
      effectiveLimitPerMonth !== null &&
      effectiveLimitPerMonth !== undefined
    ) {
      remaining = effectiveLimitPerMonth - usedThisMonth;
      if (remaining < 0) remaining = 0;
    }

    // 4. 権限フラグ
    // 追い質問は全プランで 1 回以上許可する仕様
    const can_followup =
      followupsPerHand === null ? true : followupsPerHand > 0;

    // 5. 応答
    return res.json({
      ok: true,
      user_id: userId,
      plan,
      status,
      store,
      started_at: startedAt,
      expires_at: expiresAt,
      limit_per_month: effectiveLimitPerMonth,
      used_this_month: usedThisMonth,
      remaining_this_month: remaining,
      followups_per_hand: followupsPerHand,
      can_followup,
      ads_enabled: adsEnabled,
    });
  } catch (err) {
    console.error('GET /me/plan error:', err);
    return res.status(500).json({
      ok: false,
      error: 'server_error',
    });
  }
});

module.exports = router;
