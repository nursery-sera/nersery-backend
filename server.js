// server.js（完全版）
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

// __dirname 相当（ESM：いーえすえむ）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== DB接続（でーたべーす・せつぞく）=====================================
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
    })
  : null;

// 管理トークン（とうくん）
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-token";

// ===== App 基本設定 ========================================================
const app = express();
app.set("trust proxy", true); // ぷろきし越しの https 判定を正しく
app.use(express.json({ limit: "5mb" }));

// CORS（こーず：他オリジン許可）→ www ドメインだけ許可
app.use(
  cors({
    origin: ["https://www.nurserysera.com"],
    credentials: true
  })
);

// 静的ファイル（/public）
app.use("/public", express.static(path.join(__dirname, "public")));

// ページ格納ディレクトリ
const PAGES_DIR = path.join(__dirname, "pages");

// 現在の正しいベースURLを作る（x-forwarded-proto/host 優先）
function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http")
    .toString()
    .split(",")[0];
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`; // 例: https://www.nurserysera.com
}

// ===== HTMLレンダリング（GASタグ置換対応）===================================
// - <? var url = getScriptUrl(); ?> は削除
// - <?= url ?> は自ドメイン（baseUrl）に置換（ちかん）
// - window.API_BASE を head 終了直前に注入
function renderPage(rawPage, req, res) {
  const page = (rawPage || "index").toLowerCase();
  if (!/^[a-z0-9-]+$/.test(page)) return res.status(400).send("Bad Request");

  const file = path.join(PAGES_DIR, `${page}.html`);
  if (!fs.existsSync(file)) return res.status(404).send("Not Found");

  const baseUrl = getBaseUrl(req);
  let html = fs.readFileSync(file, "utf8");

  // GASテンプレタグ置換
  html = html.replace(/\<\?\s*var\s+url\s*=\s*getScriptUrl\(\);\s*\?\>/g, ""); // 宣言削除
  html = html.replace(/\<\?\=\s*url\s*\?\>/g, baseUrl);                          // <?= url ?> → baseUrl

  // API_BASE（えーぴーあい・べーす）を注入（未定義なら入れる）
  if (!/window\.API_BASE/.test(html)) {
    html = html.replace(
      /<\/head>/i,
      `<script>window.API_BASE='${baseUrl}/api';</script></head>`
    );
  }

  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  res.send(html);
}

// ===== ルーティング（るーてぃんぐ）=========================================
// 0) /index.html /cart.html など “.html あり” への直接アクセスにも対応
app.get(/^\/([a-z0-9-]+)\.html$/i, (req, res) => {
  const page = req.params[0]; // "index" や "cart"
  return renderPage(page, req, res);
});

// 1) クエリ形式 /?page=index
app.get("/", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/public")) return next();
  const page = String(req.query.page || "index");
  return renderPage(page, req, res);
});

// 2) パス形式 /index /cart ... （/api と /public は除外）
app.get(/^\/(?!api\/|public\/)([a-z0-9-]+)?$/i, (req, res) => {
  const page = req.params[0] || "index";
  return renderPage(page, req, res);
});

// ===== API（えーぴーあい）===================================================
// ヘルスチェック
app.get("/api/health", (_, res) => res.json({ ok: true }));

// 商品一覧（DB未設定なら空配列）
app.get("/api/products", async (_, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});

// 商品の簡易追加（管理用）
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

// 注文作成
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
      const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!resp.ok) console.error("Brevo error:", await resp.text());
    } catch (e) {
      console.error("Brevo error:", e);
    }
  }

  res.json({ orderId, total });
});

// 入金反映
app.put("/api/orders/:id/paid", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  await pool.query("UPDATE orders SET is_paid = TRUE WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// 集計
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

// ===== Listen（りすん：待受）=================================================
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`App running on :${port}`));