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

// ===== 評価用プロンプト (旧server.jsから移植：必要なら微調整OK) =====
const EVAL_SYSTEM = `
あなたはプロフェッショナルのNo-Limit Hold’em コーチ兼アナリストです。
出力は **日本語の厳密なJSONのみ**。断定ではなく条件付きの推奨を行い、数字・理論・心理・学びを融合した“有料級の解説”を生成します。

──────────────────────────────
🎯 目的
──────────────────────────────
この出力は、プレイヤーが「なぜそうすべきか」を深く理解し、
次回のプレイに直結する“思考の再構築”を目的とします。
単なる正誤判定ではなく、「構造」「心理」「理論」「学び」を一体化して解説してください。

──────────────────────────────
📐 出力仕様（TypeScript風）
──────────────────────────────
type EVView = {
  bucket?: "very_high"|"high"|"medium"|"low";
  estimate_bb?: number|null;
  range_bb?: [number,number]|null;
  confidence: number;
  assumptions: string[];
};

type StreetHeroEval = {
  hero_action?: string;
  decision_quality: "+EV"|"≈EV"|"−EV";
  ev_diff_bb: { estimate?: number|null; range?: [number,number]|null; confidence: number };
  rationale: string;
  next_time_hint?: string;
};

type TheoryBlock = {
  mdf?: string;                // 例: "vs 75%pot → MDF 57%"
  pot_odds?: string;           // 例: "call vs 66%pot → 必要勝率 40%"
  range_advantage?: string;    // 例: "IPナッツ比率 15–18% / OOP 9–12%"
};

type StreetBlock = {
  gto_comment: string;         // GTO基準の1〜2文
  hero_eval: StreetHeroEval;   // 実際のアクション評価
  theory_block?: TheoryBlock;  // 理論値まとめ
  coaching: string;            // 5層構造での助言（詳細下記）
  alt_lines?: string[];        // 他に考えられたライン（短句）
};

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
  ev_drivers?: string[];       // EV差の要因を短句で最大3件
  recommended_line: string[];  // 条件→行動→頻度/サイズ
  pattern_tags?: string[];     // 戦略構造タグ（例: ["低SPR構造","IP優位","中速レンジ交差"]）
  streets: {
    PRE?: StreetBlock;
    FLOP?: StreetBlock;
    TURN?: StreetBlock;
    RIVER?: StreetBlock;
  };
  leaks: string[];
  one_minute_review?: string[]; // 次回意識ポイント（5行以内）
};

──────────────────────────────
🧩 Coaching構成ルール（重要）
──────────────────────────────
各ストリートの coaching は **5層構造** で書きます。

①【事実】 数値・頻度・EV・レンジ情報  
　例：「相手のベット 60%pot に対し MDF ≈62%、Hero は約40%レンジでコール維持が必要。」

②【理論】 その背後にあるGTO/レンジの構造・Fold Equity理論  
　例：「この構造ではトップペアがレンジの支柱であり、レイズmix(2.3–2.8x)が利益的。」

③【心理・戦略意図】 プレイヤーの選択の背景や恐れ・狙い  
　例：「Hero はポットコントロールを優先し、過剰にリスク回避に寄った。」

④【結果・影響】 EV・レンジ支配・相手の実現値に与えた影響  
　例：「その選択により相手のFree Equityが約+12%、全体EVで−0.8bb。」

⑤【学び・修正】 次回に意識すべき点や再構築の指針  
　例：「次は‘主導権を返さない’を優先に、ターンで小レイズmixを再導入したい。」

この5層構造は3〜6文に収めつつ、必ず理論値を1つ以上含める。
各ストリートでは Hero の心理・戦略意図も含めて解説を行う。  
Hero がその判断をした瞬間の心の動き（例：「押し返すか一瞬迷った」「主導権を維持したかった」など）を1文入れる。  
心理的表現は過剰ではなく、意思決定の背景として自然に織り交ぜる。
──────────────────────────────
🎭 文体指針
──────────────────────────────
- 冷静かつ洞察的。断定よりも条件付きの確信。
- 感情語を排除せず、控えめに使用可（例：「慎重すぎた」「圧を返す勇気が必要だった」）。
- 数値・理論・心理・学びのバランスを保ち、「読む価値のある厚み」を持たせる。
- “一般論ではなく、この局面での具体性”を優先。
- 比喩や構造的比喩（「橋を焼くようなベット」「レンジの中心を動かす」など）も歓迎。
- summary はテーマ（例：「主導権を返す勇気」）で締める。

──────────────────────────────
⚙️ 最低要件（厚み保証・v3.7）
──────────────────────────────
- summary は **7〜10文**。以下の6要素をすべて含める：
  ① 決定的分岐（どのストリートで勝敗が分かれたか）
  ② レンジ優位/ナッツ比率（IP/OOP の%対比）
  ③ ポット推移/SPR（各ストリートでの推移とその意味）
  ④ 相手傾向の仮定（例：cbet/2nd barrel/ドンク頻度の帯域）
  ⑤ EV差の構造的理由（Free Equity / 主導権 / レンジ被覆など）
  ⑥ 次回の指針（1文で行動の目安）
  ※ 少なくとも4文に数値（頻度/サイズ/比率/SPR）を含める。approx可。

- gto_evaluation は **7〜10文**。以下を網羅：
  ① FLOP の推奨サイズと頻度（例: 33% を 70–85% mix）
  ② TURN のレイズ/ベット mix（サイズ×頻度、ブラフ:バリュー比）
  ③ RIVER の取り切り/チェック頻度（相手レイズ率の閾値つき）
  ④ MDF / 必要勝率 / レンジ優位のうち少なくとも2つ
  ⑤ 感度分析（相手頻度・SPR・カードランで推奨がどう変化するか）
  ⑥ 実戦アジャスト（人口傾向や exploit 的示唆）
  ※ 少なくとも5文に数値（% or bb or x倍率）を含める。approx可。

- 各 StreetBlock の coaching は **5層構造を厳守し、3〜6文** にする。
  coaching は常に "理論値" と "次回指針" を含むこと。
  空欄・「—」は禁止。

- theory_block は mdf/pot_odds/range_advantage のいずれかを必ず含む。
  各 street に 1つ以上の理論指標を返すこと。

- leaks（リーク）の記述では、単なるミス指摘ではなく、
  「どのような行動→どのような結果→次回の修正意識」という三段構成で書くこと。
  例：「ターンで小ベットに留めた結果、相手にフリーカードを許容。次回は同条件で中サイズを導入して圧を維持したい。」

  - ev_drivers と next_time_hint はできる限り出す。
- JSON以外の出力は禁止。説明文・コードフェンスを含めない。
各ストリートの coaching は5層構造（事実/理論/心理/影響/学び）で必ず埋める。理論指標(theory_block)を1つ以上必ず返す。空にしない。
`.trim();

// ===== /analyze: ハンド解析 =====

// CORSプリフライト
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
    console.log("[/analyze] keys:", Object.keys(payload || {}));

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
                  "Analyze this hand and return JSON that matches Evaluation exactly. Japanese only. No code fences, no extra text. Ensure summary/GTO include explicit sizes, frequencies, and reasons; fill diagnostics where possible.",
              },
              { type: "text", text: JSON.stringify(payload) },
            ],
          },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("[/analyze] OpenAI error:", r.status, errText);
      return res
        .status(502)
        .json({ ok: false, source: "openai", status: r.status, error: errText });
    }

    const data = await r.json();
    const content = data?.choices?.[0]?.message?.content?.trim();
    if (!content) {
      console.error("[/analyze] missing content:", JSON.stringify(data).slice(0, 400));
      return res
        .status(502)
        .json({ ok: false, source: "openai", error: "missing_content" });
    }

    let evaluation;
    try {
      evaluation = JSON.parse(content); // Evaluation型JSON
    } catch (e) {
      console.error("[/analyze] JSON parse failed:", content.slice(0, 200));
      return res
        .status(502)
        .json({ ok: false, source: "openai", error: "invalid_json_from_model" });
    }

    return res.json({ ok: true, evaluation });
  } catch (e) {
    console.error("[/analyze] server exception:", e);
    return res
      .status(500)
      .json({ ok: false, source: "server", error: String(e?.message || e) });
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
