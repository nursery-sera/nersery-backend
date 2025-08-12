// server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

// __dirname 相当（ESM：いーえすえむ。ES Modulesの略）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== DB接続（でーたべーす・せつぞく）======
// DATABASE_URL が無ければ pool は null（ぬる：未接続扱い）
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      // Railway等のマネージドDBはSSL必須のことが多い
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
    })
  : null;

// 管理用トークン（とうくん：パスワードの代わりの合言葉）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-token";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// 静的ファイル（/public：ぱぶりっく配下の画像やJS/CSSを配信）
app.use("/public", express.static(path.join(__dirname, "public")));

// ページ格納ディレクトリ
const PAGES_DIR = path.join(__dirname, "pages");

// ====== HTMLレンダリング関数（GAS互換タグ差し込み対応）======
// renderPage('index', req, res) のように使う
function renderPage(rawPage, req, res) {
  // ページ名バリデーション（ばりでーしょん：不正入力を弾く）
  const page = (rawPage || "index").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(page)) {
    return res.status(400).send("Bad Request");
  }
  const file = path.join(PAGES_DIR, `${page}.html`);
  if (!fs.existsSync(file)) return res.status(404).send("Not Found");

  const host = req.get("host");
  const baseUrl = `${req.protocol}://${host}`; // GASの getScriptUrl() 相当
  let html = fs.readFileSync(file, "utf8");

  // GASテンプレタグ置換（ちかん：入れ替え）
  // 1) 宣言行 <? var url = getScriptUrl(); ?> は消す
  html = html.replace(/\<\?\s*var\s+url\s*=\s*getScriptUrl\(\);\s*\?\>/g, "");
  // 2) <?= url ?> を baseUrl に置換
  html = html.replace(/\<\?\=\s*url\s*\?\>/g, baseUrl);

  // window.API_BASE（えーぴーあい・べーす：APIの基準URL）を注入
  if (!/window\.API_BASE/.test(html)) {
    html = html.replace(
      /<\/head>/i,
      `<script>window.API_BASE='${baseUrl}/api';</script></head>`
    );
  }

  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  res.send(html);
}

// ====== ルーティング（path形式 & query形式 両対応）======
// 1) クエリ形式 /?page=index
app.get("/", (req, res, next) => {
  // /api や /public に来たアクセスはスキップ
  if (req.path.startsWith("/api") || req.path.startsWith("/public")) return next();
  const page = String(req.query.page || "index");
  return renderPage(page, req, res);
});

// 2) パス形式 /index /cart /policy ... に対応
//    /api/* と /public/* を除く全てを最終的にページとして試す
app.get(/^\/(?!api\/|public\/)([a-z0-9-]+)?$/i, (req, res) => {
  const page = req.params[0] || "index";
  return renderPage(page, req, res);
});

// ====== API（えーぴーあい：アプリ間のやり取りの窓口）======
// ヘルスチェック（へるすちぇっく：生存確認）
app.get("/api/health", (_, res) => res.json({ ok: true }));

// 商品一覧（DB未設定なら空配列）
app.get("/api/products", async (_, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});

// 商品の簡易追加（管理画面やChatGPT連携用）
app.post("/api/products/quick-add", async (req, res) => {
  if (req.body?.token !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  if (!pool) {
    return res
      .status(500)
      .json({ error: "DATABASE_URL not set (DB not available)" });
  }
  const { name, price, imageUrl, category, sku } = req.body || {};
  const q = `INSERT INTO products(name, price, image_url, category, sku)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`;
  const { rows } = await pool.query(q, [
    name,
    price,
    imageUrl,
    category || null,
    sku || null
  ]);
  res.json(rows[0]);
});

// 注文作成（ちゅうもん・さくせい）
app.post("/api/orders", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });

  const { customer, note, items } = req.body || {};
  const c = await pool.query(
    "INSERT INTO customers(name,email,address) VALUES ($1,$2,$3) RETURNING id",
    [customer.name, customer.email, customer.address]
  );
  const customerId = c.rows[0].id;

  const total = (items || []).reduce(
    (s, it) => s + Number(it.unitPrice || 0) * Number(it.quantity || 1),
    0
  );

  const o = await pool.query(
    "INSERT INTO orders(customer_id, note, total_amount) VALUES ($1,$2,$3) RETURNING id",
    [customerId, note || null, total]
  );
  const orderId = o.rows[0].id;

  // Brevo（ぶれぼ：メール送信API）で自動返信
  if (process.env.BREVO_API_KEY) {
    const body = {
      sender: {
        email: process.env.MAIL_FROM || "info@example.com",
        name: process.env.MAIL_NAME || "nursery sera"
      },
      to: [{ email: customer.email, name: customer.name }],
      subject: `ご注文ありがとうございます（#${orderId}）`,
      htmlContent: `
        <p>${customer.name} 様</p>
        <p>ご注文（#${orderId}）を受け付けました。</p>
        <p>合計：${total.toLocaleString()}円</p>
        <p>お支払い方法：銀行振込</p>
        <p>※ご入金確認後に発送いたします。</p>
      `
    };
    try {
      // Node18+ なら fetch はグローバル（ぐろーばる：標準で使える）
      const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": process.env.BREVO_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      });
      if (!resp.ok) {
        console.error("Brevo error:", await resp.text());
      }
    } catch (e) {
      console.error("Brevo error:", e);
    }
  }

  res.json({ orderId, total });
});

// 入金反映（にゅうきん・はんえい）
app.put("/api/orders/:id/paid", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  await pool.query("UPDATE orders SET is_paid = TRUE WHERE id = $1", [
    req.params.id
  ]);
  res.json({ ok: true });
});

// 集計（しゅうけい）
app.get("/api/reports/category", async (_, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query(
    "SELECT * FROM v_category_summary ORDER BY total_qty DESC"
  );
  res.json(rows);
});
app.get("/api/reports/all", async (_, res) => {
  if (!pool) return res.json({ total_amount: 0, total_orders: 0 });
  const { rows } = await pool.query("SELECT * FROM v_all_total");
  res.json(rows[0] || { total_amount: 0, total_orders: 0 });
});

// ====== Listen（りすん：待ち受け開始）======
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`App running on :${port}`));