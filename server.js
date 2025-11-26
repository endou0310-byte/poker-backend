require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./src/db/pool");

// ===== Stripe 設定 =====
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const FRONTEND_URL = process.env.FRONTEND_URL || "http://localhost:5173";

// プランごとの PriceID（Stripe ダッシュボードで発行したものを .env に入れる）
const STRIPE_PRICE_BASIC = process.env.STRIPE_PRICE_BASIC || "";
const STRIPE_PRICE_PRO = process.env.STRIPE_PRICE_PRO || "";
const STRIPE_PRICE_PREMIUM = process.env.STRIPE_PRICE_PREMIUM || "";

// server 側で plan ↔ priceId を管理する
const PLAN_TO_PRICE = {
  basic: STRIPE_PRICE_BASIC,
  pro: STRIPE_PRICE_PRO,
  premium: STRIPE_PRICE_PREMIUM,
};
const PRICE_TO_PLAN = Object.fromEntries(
  Object.entries(PLAN_TO_PRICE).map(([plan, price]) => [price, plan])
);

const stripe =
  STRIPE_SECRET_KEY && STRIPE_WEBHOOK_SECRET
    ? require("stripe")(STRIPE_SECRET_KEY)
    : null;

const app = express();


// ===== CORS =====
// ローカル + GitHub Pages の "オリジン" を許可する
const allowedOrigins = [
  "http://localhost:5173",
  "https://endou0310-byte.github.io",   // ← ここを固定で追加
];

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin) return callback(null, true); // origin なしは許可

    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Not allowed by CORS: " + origin));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));
// プリフライトも同じ設定で返す
app.options(/.*/, cors(corsOptions));

/**
 * Stripe Webhook（raw body が必要なので express.json より前に定義）
 * ここでは checkout.session.completed が来たら subscriptions に active プランを登録します。
 */
if (stripe) {
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json" }),
    async (req, res) => {
      const sig = req.headers["stripe-signature"];

      let event;
      try {
        event = stripe.webhooks.constructEvent(
          req.body,
          sig,
          STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.error("[stripe/webhook] signature error:", err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
      }

      try {
        switch (event.type) {
          case "checkout.session.completed": {
            const session = event.data.object;
            const userId = session.metadata?.user_id;
            const planFromMeta = session.metadata?.plan || null;

            // line_items は expand 指定がないと取れないので、
            // 基本的には metadata の plan を信頼する形にしておく
            const plan = planFromMeta;

            if (userId && plan) {
              await pool.query(
                `INSERT INTO subscriptions
                   (user_id, plan, status, store, started_at, purchase_token)
                 VALUES ($1, $2, 'active', 'stripe', NOW(), $3)`,
                [userId, plan, session.id]
              );
              console.log(
                "[stripe/webhook] subscription inserted:",
                userId,
                plan
              );
            } else {
              console.warn(
                "[stripe/webhook] missing user_id or plan in metadata"
              );
            }
            break;
          }

          // 今後必要なら invoice.payment_failed 等もここでハンドリング
          default:
            // 特に処理不要のイベントはそのまま流す
            break;
        }

        res.json({ received: true });
      } catch (err) {
        console.error("[stripe/webhook] handler error:", err);
        res.status(500).send("Webhook handler error");
      }
    }
  );
}

// ===== JSON =====
app.use(express.json());


// ===== 既存ルータ(auth / me) =====
const authRouter = require("./src/routes/auth");
const planRouter = require("./src/routes/plan");

app.use("/auth", authRouter);
app.use("/plan", planRouter);
// /history 系はこのファイルの後半で直書きしているので、
// ここでの historyRouter は不要

// ===== Stripe: Checkout セッション作成 =====
app.post("/stripe/create-checkout-session", async (req, res) => {
  try {
    if (!stripe) {
      return res
        .status(500)
        .json({ ok: false, error: "stripe_not_configured" });
    }

    const { user_id, email, plan } = req.body || {};
    if (!user_id || !plan) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    const priceId = PLAN_TO_PRICE[plan];
    if (!priceId) {
      return res.status(400).json({ ok: false, error: "unknown_plan" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      customer_email: email || undefined,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        user_id,
        plan,
      },
      success_url: `${FRONTEND_URL}/stripe-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${FRONTEND_URL}/stripe-cancel.html`,
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error("[/stripe/create-checkout-session] error:", err);
    return res
      .status(500)
      .json({ ok: false, error: "stripe_session_error" });
  }
});


// ===== healthcheck =====
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    message: "server is running",
    time: new Date().toISOString(),
  });
});

// ===== OpenAI設定 =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.MODEL || "gpt-4o-mini";

if (!OPENAI_API_KEY) {
  console.error("❌ OPENAI_API_KEY が設定されていません");
  process.exit(1);
}

// Node18+ なら fetch はグローバルに存在する前提で使う

// ===== プラン設定（server.js 用。plan.js と同じ内容をここにも定義） =====
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
    limit_per_month: null, // 無制限
    followups_per_hand: null, // 無制限
    ads_enabled: false,
  },
};

function getMonthRange() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0);
  return { start, end };
}

// ユーザーのプラン情報を取得（subscriptions + PLAN_CONFIG）
async function getUserPlanInfo(userId) {
  // 最新の active サブスクを1件取得
  const subRes = await pool.query(
    `SELECT plan, status, limit_per_month
       FROM subscriptions
      WHERE user_id = $1
        AND status = 'active'
      ORDER BY started_at DESC
      LIMIT 1`,
    [userId]
  );

  let plan = "free";
  let status = "none";
  let limitPerMonthOverride = null;

  if (subRes.rowCount > 0) {
    const row = subRes.rows[0];
    plan = row.plan || "free";
    status = row.status || "active";
    limitPerMonthOverride =
      row.limit_per_month !== undefined ? row.limit_per_month : null;
  }

  const cfg = PLAN_CONFIG[plan] || PLAN_CONFIG.free;
  const baseLimitPerMonth = cfg.limit_per_month; // number | null
  const followupsPerHand = cfg.followups_per_hand; // number | null
  const adsEnabled = !!cfg.ads_enabled;

  const effectiveLimitPerMonth =
    limitPerMonthOverride !== null && limitPerMonthOverride !== undefined
      ? limitPerMonthOverride
      : baseLimitPerMonth;

  return {
    plan,
    status,
    limit_per_month: effectiveLimitPerMonth,
    followups_per_hand: followupsPerHand,
    ads_enabled: adsEnabled,
  };
}

const EVAL_SYSTEM = `
あなたはプロフェッショナルのNo-Limit Hold’em コーチ兼アナリストです。
プレイヤーから渡される1ハンドの情報をもとに、
数字・理論・心理・学びを融合した “有料級の日本語解説レポート” を作成します。

──────────────────────────────
🎯 目的
──────────────────────────────
この出力は、プレイヤーが「なぜそうすべきか」を深く理解し、
次回のプレイに直結する“思考の再構築”を目的とします。
単なる正誤判定ではなく、「構造」「心理」「理論」「学び」を一体化して解説してください。

──────────────────────────────
📐 構成仕様（概念モデル）
──────────────────────────────
以下の Evaluation 構造は型定義ではなく「含めるべき情報リスト」です。
実際の出力は、人間が読む日本語テキストとしてこれらを順番に表現してください。
JSONやコードブロックではなく、見出しと文章で書きます。

type Evaluation = {
  summary: string;             // ハンド全体のテーマ・分岐点・心理的背景
  gto_evaluation: string;      // レンジ・頻度・サイズ・比率の分析（3文以上）
  // EV評価は、プレイヤーが直感的に理解しやすい日本語テキストとして出力する。
  // 以下の3ブロックを、この順番で1つのテキストにまとめること：
  //  ①【EV差の要約】… 推定EV差を「おおまかなbbの得失」で1行で説明（例: 約+1.5BBの利益）
  //  ②【EV差が生まれた理由】… 主な要因を1〜2行で説明
  //  ③【改善ポイント】… 次回の具体的な行動指針を1〜3行で示す
  // 数値や推定根拠は文章の中に自然に埋め込む。JSON風のキー名や英語ラベルは一切出さない。
  ev_evaluation: string;
  ev_drivers?: string[];       // EV差の要因（最大3件）
  recommended_line: string[];  // 条件→行動→頻度/サイズ の推奨ライン
  pattern_tags?: string[];
  streets: {
    PRE?: StreetBlock;
    FLOP?: StreetBlock;
    TURN?: StreetBlock;
    RIVER?: StreetBlock;
  };
  leaks: string[];
  one_minute_review?: string[]; // 次回意識ポイント（5行以内）
};

type StreetBlock = {
  gto_comment: string;
  hero_eval: StreetHeroEval;
  theory_block?: TheoryBlock;
  // 各ストリートでの「評価と具体的アドバイス」をまとめた文章
  coaching: string;
  alt_lines?: string[];
};

──────────────────────────────
🧩 Coaching構成ルール（重要）
──────────────────────────────
各ストリートの coaching は、「そのストリートで何が良く／悪く、次回どうプレイすべきか」が
一目で分かる“アドバイス中心”の構成にします。

①【評価】 現在のラインがGTO上・実戦的にどの程度妥当か（良かった点／問題点）
②【推奨ライン】 そのスポットで標準的に推奨されるアクションやベットサイズ・頻度
③【代替プラン】 取りうる別ライン（チェック・ベット小さめ／大きめ等）と、それを選ぶ条件
④【次回の指針】 次回同様の局面で何を基準に判断すべきか（レンジ・SPR・ブロッカー・相手タイプなど）

各ストリートごとに 3〜6 文でこれらを自然な文章としてまとめ、
可能であれば 1 つ以上の具体的な数値指標（% / bb / x / MDF / ポットオッズなど）も含めてください。

──────────────────────────────
💰 EV評価の構成ルール（パターンA）
──────────────────────────────
EV評価セクションでは、次の3ブロックをこの順番で必ず含めてください。

①【EV差の要約】
- ハンド全体として「どの程度プラス or マイナスEVだったか」を、おおまかなbbで1行で説明します。
- 例: 「このハンドの総合的なEV差は、およそ+1.5BBの利益が見込まれるラインです。」

②【EV差が生まれた理由】
- 1〜2行で、EV差の主な要因だけを簡潔に説明します。
- 例: 「ターンでのチェックレイズが、相手の弱いレンジに強く働きかけたことが主な要因です。」

③【改善ポイント】
- 1〜3行で、次回どのようにプレイすべきかを具体的に書きます。
- 例: 「同様のボードでは、フロップで小さめのCBを混ぜることで、レンジ優位を活かしてEVをさらに伸ばせます。」

※ 注意:
- ev_mode や assumptions などの英語キー名は一切出さない。
- JSON風の羅列にはせず、すべて自然な日本語文章として書くこと。

──────────────────────────────
🎭 文体指針
──────────────────────────────
- 冷静かつ洞察的。断定より条件付きの根拠を示す。
- “一般論”ではなく、この局面の具体的背景に紐づける。
- 数値・理論・心理・学びのバランスを取り、「読む価値のある厚み」を持たせる。

──────────────────────────────
⚙️ 最低要件
──────────────────────────────
- 「総評」セクションでハンド全体のテーマと分岐点を7〜10文で述べる。
- 「GTO評価」で推奨サイズ・頻度・レンジ優位などを7〜10文で述べる。
- PRE/FLOP/TURN/RIVER それぞれについて、上記のCoaching構成ルールに従い、
  「評価」「推奨ライン」「代替プラン」「次回の指針」を含む具体的アドバイスを書く。
- 「リーク」と「1分復習」を箇条書きでまとめる。
- 最後に簡潔な「アクション履歴」を付ける。

【アクション履歴のフォーマット】
- 各ストリートを1行ずつ、以下のように書くこと：
  - 例: PRE: UTG(YOU) Raise 2.5BB → HJ Call → CO Call
  - 例: FLOP: UTG(YOU) Check → HJ Bet 3.5BB → CO Call → UTG(YOU) Call
- Heroの座席には必ず「(YOU)」を付ける。
- ストリート名は PRE / FLOP / TURN / RIVER の英語表記で統一する。

【重要】実際の出力形式
- 上記の情報を、以下のような見出し付きテキストとして順番に出力してください。
  - 「総評」
  - 「GTO評価」
  - 「EV評価」
  - 「ストリート別評価（PRE / FLOP / TURN / RIVER）」
  - 「リーク」
  - 「1分復習」
  - 「アクション履歴」
- JSONやコードフェンス（\`\`\`）は使わない。
- 余計な前置きやシステム説明は書かない。解析結果のみを書く。
`.trim();


// ===== /analyze: ハンド解析 =====

// CORS プリフライト対応
app.options("/analyze", (_req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  });
  res.status(204).end();
});

app.post("/analyze", async (req, res) => {
  const payload = req.body || {};

  try {
    console.log("[/analyze] payload keys:", Object.keys(payload || {}));

    const userId = payload.user_id;
    const handId = payload.hand_id || payload.handId || null;

    if (!userId) {
      return res.status(400).json({
        ok: false,
        source: "server",
        error: "missing_user_id",
      });
    }

    // プラン情報 + 今月の使用状況を取得
    const planInfo = await getUserPlanInfo(userId);
    const { limit_per_month: limitPerMonth } = planInfo;

    let usedThisMonth = 0;
    if (limitPerMonth !== null && limitPerMonth !== undefined) {
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
      usedThisMonth = usageRes.rows[0].cnt;

      if (usedThisMonth >= limitPerMonth) {
        return res.status(403).json({
          ok: false,
          source: "plan",
          error: "analysis_limit_exceeded",
          detail: {
            plan: planInfo.plan,
            limit_per_month: limitPerMonth,
            used_this_month: usedThisMonth,
          },
        });
      }
    }

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.45,
        max_tokens: 5000,
        messages: [
          { role: "system", content: EVAL_SYSTEM },
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "以下のハンド情報を解析し、指示された構成で日本語の詳細レポートを出力してください。" +
                  "出力は JSON ではなく、見出し付きの自然なテキストで返してください。",
              },
              {
                type: "text",
                text: JSON.stringify(payload),
              },
            ],
          },
        ],
      }),
    });

    // OpenAI 側で HTTP エラー
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("[/analyze] OpenAI error:", r.status, errText);
      return res.status(502).json({
        ok: false,
        source: "openai",
        status: r.status,
        error: errText || "bad_status_from_openai",
      });
    }

    const data = await r.json();
    const content =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content
        ? String(data.choices[0].message.content).trim()
        : "";

    if (!content) {
      console.error(
        "[/analyze] missing content:",
        JSON.stringify(data).slice(0, 400)
      );
      return res.status(502).json({
        ok: false,
        source: "openai",
        error: "missing_content",
      });
    }

    // 使用ログを1件追加（解析成功時のみ）
    try {
      await pool.query(
        `INSERT INTO usage_logs (user_id, action_type, hand_id)
         VALUES ($1, 'analyze', $2)`,
        [userId, handId]
      );
      usedThisMonth += 1;
    } catch (e) {
      console.error("[/analyze] failed to insert usage_logs:", e);
      // ログ挿入失敗は解析結果自体には影響させない
    }

    // ここでは JSON にパースせず、テキストとしてそのまま返す
    return res.json({
      ok: true,
      text: content,
      usage: {
        plan: planInfo.plan,
        limit_per_month: limitPerMonth,
        used_this_month: usedThisMonth,
      },
    });
  } catch (e) {
    console.error("[/analyze] server exception:", e);
    return res.status(500).json({
      ok: false,
      source: "server",
      error: String(e && e.message ? e.message : e),
    });
  }
});


// ===== /followup: 追い質問 =====

const FU_SYS = `
あなたは同じポーカーコーチです。
既に与えられたハンド評価(evaluation)とスナップショット(snapshot)を前提に、
ユーザーからの追い質問に日本語で簡潔にJSON回答を返します。

type Followup = {
  refusal: boolean;
  message?: string;
  addendum?: string;
  effects?: string[];
  line_adjust?: string[];
};
`.trim();

app.post("/followup", async (req, res) => {
  try {
    const { snapshot, evaluation, question, user_id, hand_id, handId } =
      req.body || {};

    const normalizedHandId = hand_id ?? handId ?? null;

    if (
      !snapshot ||
      !question ||
      typeof question !== "string" ||
      !user_id ||
      !normalizedHandId
    ) {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    // プラン情報取得（1ハンドあたりの追い質問上限）
    const planInfo = await getUserPlanInfo(user_id);
    const followupsPerHand = planInfo.followups_per_hand;

    let usedForThisHand = 0;
    if (followupsPerHand !== null && followupsPerHand !== undefined) {
      const usageRes = await pool.query(
        `SELECT COUNT(*)::int AS cnt
           FROM usage_logs
          WHERE user_id = $1
            AND hand_id = $2
            AND action_type = 'followup'`,
        [user_id, normalizedHandId]
      );
      usedForThisHand = usageRes.rows[0].cnt;

      if (usedForThisHand >= followupsPerHand) {
        return res.status(403).json({
          ok: false,
          error: "followup_limit_exceeded",
          detail: {
            plan: planInfo.plan,
            followups_per_hand: followupsPerHand,
            used_for_this_hand: usedForThisHand,
          },
        });
      }
    }

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.3,
        max_tokens: 1000,
        messages: [
          { role: "system", content: FU_SYS },
          {
            role: "user",
            content: [
              { type: "text", text: "Base Evaluation:" },
              { type: "text", text: JSON.stringify(evaluation || {}) },
              { type: "text", text: "Snapshot:" },
              { type: "text", text: JSON.stringify(snapshot || {}) },
              { type: "text", text: "Question:" },
              { type: "text", text: question },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    const j = await r.json();
    const content = j?.choices?.[0]?.message?.content?.trim() || "{}";
    let result;
    try {
      result = JSON.parse(content);
    } catch {
      result = { refusal: false, message: content };
    }

    // 追い質問の使用ログ
    try {
      await pool.query(
        `INSERT INTO usage_logs (user_id, action_type, hand_id)
         VALUES ($1, 'followup', $2)`,
        [user_id, normalizedHandId]
      );
      usedForThisHand += 1;
    } catch (e) {
      console.error("[/followup] failed to insert usage_logs:", e);
    }

    return res.json({
      ok: true,
      result,
      followup_usage: {
        plan: planInfo.plan,
        followups_per_hand: followupsPerHand,
        used_for_this_hand: usedForThisHand,
      },
    });
  } catch (e) {
    console.error("[/followup] error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

/* =============================
    hand history APIs
=============================*/

// 保存
app.post("/history/save", async (req, res) => {
  try {
    const {
      user_id,
      hand_id,
      handId, // ← どちらで来ても受け取れるようにする
      snapshot,
      evaluation,
      conversation,
      markdown,
      title, // ★ 追加（任意）
    } = req.body;

    // hand_id or handId のどちらかに値があれば OK
    const normalizedHandId = hand_id ?? handId;

    if (!user_id || !normalizedHandId) {
      return res
        .status(400)
        .json({ ok: false, error: "missing_parameters" });
    }

    // 初期タイトル（未指定なら Hand #hand_xxx 形式）
    const initialTitle =
      typeof title === "string" && title.trim()
        ? title.trim()
        : `Hand #${normalizedHandId}`;

    const result = await pool.query(
      `
      INSERT INTO hand_histories
        (user_id, hand_id, title, snapshot, evaluation, conversation, markdown)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING id
      `,
      [
        user_id,
        normalizedHandId,
        initialTitle,
        snapshot ?? null,
        evaluation ?? null,
        conversation ?? null,
        markdown ?? null,
      ]
    );

    res.json({ ok: true, id: result.rows[0].id });
  } catch (err) {
    console.error("POST /history/save error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ================================
// conversation append API（★修正）
// ================================
app.post("/history/update-conversation", async (req, res) => {
  try {
    const { id, user_id, hand_id, conversation } = req.body || {};

    // conversation は必須で配列
    if (!Array.isArray(conversation)) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
      });
    }

    let targetId = id ?? null;

    // id が無い場合は user_id + hand_id から最新レコードを引く
    if (!targetId) {
      if (user_id && hand_id) {
        const lookup = await pool.query(
          `
          SELECT id
            FROM hand_histories
           WHERE user_id = $1
             AND hand_id = $2
           ORDER BY created_at DESC
           LIMIT 1
          `,
          [user_id, hand_id]
        );

        if (lookup.rowCount > 0) {
          targetId = lookup.rows[0].id;
        } else {
          // まだ履歴が無い場合は「何もせず成功扱い」にしてフロントのエラーを防ぐ
          return res.json({
            ok: true,
            skipped: true,
            reason: "history_not_found",
          });
        }
      } else {
        return res.status(400).json({
          ok: false,
          error: "bad_request",
        });
      }
    }

    // JSON 文字列にしてから jsonb として保存
    const convJson = JSON.stringify(conversation);

    const result = await pool.query(
      `
      UPDATE hand_histories
         SET conversation = $1::jsonb
       WHERE id = $2
       RETURNING id
      `,
      [convJson, targetId]
    );

    if (result.rowCount === 0) {
      // id 指定で見つからない場合だけは 404 にする
      return res.status(404).json({
        ok: false,
        error: "not_found",
      });
    }

    return res.json({ ok: true });
  } catch (e) {
    console.error("[/history/update-conversation] error:", e);
    return res.status(500).json({
      ok: false,
      error: String(e?.message || e),
    });
  }
});

// タイトル更新
app.post("/history/update-title", async (req, res) => {
  try {
    const { user_id, id, title } = req.body || {};

    if (!user_id || !id || typeof title !== "string") {
      return res.status(400).json({ ok: false, error: "bad_request" });
    }

    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      return res.status(400).json({ ok: false, error: "empty_title" });
    }

    const result = await pool.query(
      `
      UPDATE hand_histories
         SET title = $1
       WHERE id = $2
         AND user_id = $3
       RETURNING id, hand_id, title, created_at
      `,
      [normalizedTitle, id, user_id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ ok: false, error: "not_found" });
    }

    return res.json({ ok: true, history: result.rows[0] });
  } catch (err) {
    console.error("POST /history/update-title error:", err);
    return res.status(500).json({ ok: false, error: "server_error" });
  }
});

// 一覧
app.get("/history/list", async (req, res) => {
  try {
    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "missing_user_id" });
    }

    const result = await pool.query(
      `
      SELECT id, hand_id, title, created_at, snapshot
      FROM hand_histories
      WHERE user_id = $1
      ORDER BY created_at DESC
      LIMIT 100
      `,
      [user_id]
    );

    res.json({
      ok: true,
      items: result.rows,
    });
  } catch (err) {
    console.error("GET /history/list error:", err);
    res.status(500).json({
      ok: false,
      error: "server_error",
      detail: err.message, // ← エラー内容を返す
    });
  }
});


// 詳細
app.get("/history/detail", async (req, res) => {
  try {
    const { id } = req.query;

    if (!id) {
      return res.status(400).json({ ok: false, error: "missing_id" });
    }

    const result = await pool.query(
      `SELECT *
       FROM hand_histories
       WHERE id = $1`,
      [id]
    );

    if (result.rows.length === 0) {
      return res.json({ ok: false, error: "not_found" });
    }

    res.json({ ok: true, history: result.rows[0] });
  } catch (err) {
    console.error("GET /history/detail error:", err);
    res.status(500).json({ ok: false, error: "server_error" });
  }
});

// ================================
// 履歴全削除 API（★新規追加）
// ================================
app.delete("/history/delete_all", async (req, res) => {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        ok: false,
        error: "missing_user_id",
      });
    }

    const result = await pool.query(
      `DELETE FROM hand_histories WHERE user_id = $1`,
      [user_id]
    );

    return res.json({
      ok: true,
      deleted: result.rowCount,
    });
  } catch (err) {
    console.error("DELETE /history/delete_all error:", err);
    return res.status(500).json({
      ok: false,
      error: "server_error",
    });
  }
});

// ===== 起動 =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});


