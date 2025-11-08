// server.js : PokerGPT backend (Railway)
// - Google認証やプラン情報(/auth, /me) は既存ルータを使用
// - 解析API: POST /analyze
// - 追い質問API: POST /followup

require("dotenv").config();
const express = require("express");
const cors = require("cors");

const app = express();

// ===== CORS =====
app.use(
  cors({
    origin: "*", // 必要に応じて本番ドメインに絞る
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// ===== JSON =====
app.use(express.json());

// ===== 既存ルータ(auth / me) =====
const authRouter = require("./src/routes/auth");
const planRouter = require("./src/routes/plan");

app.use("/auth", authRouter);
app.use("/me", planRouter);

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
  ev_evaluation: {
    ev_mode: "bucketed"|"range"|"solver";
    overall_diff_bb?: { estimate?: number|null; range?: [number,number]|null; confidence: number };
    why: string;
    assumptions: string[];
    was_hero_line_reasonable: boolean;
  };
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
  coaching: string;            // 下記5層構造での助言
  alt_lines?: string[];
};

──────────────────────────────
🧩 Coaching構成ルール（重要）
──────────────────────────────
各ストリートの coaching は **5層構造** で書きます。

①【事実】 数値・頻度・EV・レンジ情報
②【理論】 GTO/レンジ構造やFold Equity理論
③【心理・戦略意図】 判断の背景や狙い
④【結果・影響】 EV・レンジ支配・実現値への影響
⑤【学び・修正】 次回に意識すべき具体的指針

各ストリートごとに、3〜6文でこの5要素を含め、
少なくとも1つは具体的な数値指標（% / bb / x / MDF / ポットオッズなど）を入れてください。

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
- PRE/FLOP/TURN/RIVER それぞれについて、coaching 5層構造に従った解説を書く。
- 「リーク」と「1分復習」を箇条書きでまとめる。
- 最後に簡潔な「アクション履歴サマリ」を付ける。

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
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content
      ? String(data.choices[0].message.content).trim()
      : "";

    if (!content) {
      console.error("[/analyze] missing content:", JSON.stringify(data).slice(0, 400));
      return res.status(502).json({
        ok: false,
        source: "openai",
        error: "missing_content",
      });
    }

    // ここでは JSON にパースせず、テキストとしてそのまま返す
    return res.json({
      ok: true,
      text: content,
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


// ===== /followup: 追い質問（1回まで想定・ロジックはフロントで制御） =====

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
    const { snapshot, evaluation, question } = req.body || {};
    if (!snapshot || !question || typeof question !== "string") {
      return res.status(400).json({ ok: false, error: "bad_request" });
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

    return res.json({ ok: true, result });
  } catch (e) {
    console.error("[/followup] error:", e);
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ===== 起動 =====
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`API server listening on port ${PORT}`);
});
