const express = require('express');
const router = express.Router();
const pool = require('../db/pool');

// ===== Stripe 設定（server.js と同様）=====
const STRIPE_MODE = (process.env.STRIPE_MODE || "live").toLowerCase();
const STRIPE_ENV_SUFFIX = STRIPE_MODE === "test" ? "TEST" : "LIVE";
const pickEnv = (baseName) =>
  process.env[`${baseName}_${STRIPE_ENV_SUFFIX}`] || process.env[baseName] || "";

const STRIPE_SECRET_KEY = pickEnv("STRIPE_SECRET_KEY");
const stripe = STRIPE_SECRET_KEY ? require("stripe")(STRIPE_SECRET_KEY) : null;

const STRIPE_PRICE_BASIC = pickEnv("STRIPE_PRICE_BASIC");
const STRIPE_PRICE_PRO = pickEnv("STRIPE_PRICE_PRO");
const STRIPE_PRICE_PREMIUM = pickEnv("STRIPE_PRICE_PREMIUM");

const PLAN_TO_PRICE = {
  basic: STRIPE_PRICE_BASIC,
  pro: STRIPE_PRICE_PRO,
  premium: STRIPE_PRICE_PREMIUM,
};

const PLAN_RANK = { free: 0, basic: 1, pro: 2, premium: 3 };

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
    followups_per_hand: 3,
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

router.post("/change", async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).json({ ok: false, error: "stripe_not_configured" });
    }

    const { user_id, new_plan } = req.body || {};
    if (!user_id || !new_plan) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    const newPriceId = PLAN_TO_PRICE[new_plan];
    if (!newPriceId) {
      return res.status(400).json({ ok: false, error: "unknown_plan" });
    }

    // いまの active をDBから取得（sub_... が purchase_token に入っている前提）
    const subRes = await pool.query(
      `
      SELECT plan, purchase_token
      FROM subscriptions
      WHERE user_id = $1
        AND status = 'active'
        AND store = 'stripe'
      ORDER BY started_at DESC
      LIMIT 1
      `,
      [user_id]
    );

    if (subRes.rowCount === 0) {
      return res.status(400).json({ ok: false, error: "no_active_subscription" });
    }

    const currentPlan = subRes.rows[0].plan;
    const stripeSubId = subRes.rows[0].purchase_token;

    if (!stripeSubId || !stripeSubId.startsWith("sub_")) {
      return res.status(400).json({ ok: false, error: "missing_stripe_subscription_id" });
    }

    if (currentPlan === new_plan) {
      return res.json({ ok: true, action: "noop", plan: currentPlan });
    }

    const currentRank = PLAN_RANK[currentPlan] ?? 0;
    const newRank = PLAN_RANK[new_plan] ?? 0;

    // Stripe subscription を取得して itemId を確定
    const sub = await stripe.subscriptions.retrieve(stripeSubId);
    const itemId = sub.items?.data?.[0]?.id;
    if (!itemId) {
      return res.status(500).json({ ok: false, error: "missing_subscription_item" });
    }

    // アップグレード：即時変更 + 差額日割り（更新日は維持）
    if (newRank > currentRank) {
      const updated = await stripe.subscriptions.update(stripeSubId, {
        items: [{ id: itemId, price: newPriceId }],
        proration_behavior: "create_prorations",
      });

      return res.json({
        ok: true,
        action: "upgraded",
        from: currentPlan,
        to: new_plan,
        current_period_end: updated.current_period_end,
      });
    }

    // ダウングレード：次回更新から反映（返金なし）＝ subscription schedule を使う
    // 既存サイクル満了まで現在プランを維持し、次フェーズで new_plan に切替
    const schedule = await stripe.subscriptionSchedules.create({
      from_subscription: stripeSubId,
    });

    const currentPhase = schedule.phases?.[0];
    const endDate = currentPhase?.end_date;
    if (!endDate) {
      return res.status(500).json({ ok: false, error: "missing_phase_end_date" });
    }

    const updatedSchedule = await stripe.subscriptionSchedules.update(schedule.id, {
      phases: [
        // 現在のフェーズはそのまま（満了まで）
        {
          items: currentPhase.items.map((it) => ({ price: it.price })),
          start_date: currentPhase.start_date,
          end_date: endDate,
        },
        // 次フェーズでダウングレード
        {
          items: [{ price: newPriceId }],
          start_date: endDate,
        },
      ],
    });

    return res.json({
      ok: true,
      action: "downgrade_scheduled",
      from: currentPlan,
      to: new_plan,
      effective_at: updatedSchedule.phases?.[1]?.start_date || endDate,
    });
  } catch (err) {
    console.error("POST /plan/change error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});


router.get('/', async (req, res) => {
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
