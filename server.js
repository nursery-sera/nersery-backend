// server.js — public優先 + API（全部入り）
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

// __dirname（でぃあーねいむ：現在ファイルの場所）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== 設定（せってい） ======
const ROOT_DIR   = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public"); // ← あなたのHTMLはここにある
const PAGES_DIR  = path.join(ROOT_DIR, "pages");  // 予備（なければ無視OK）

// ★ www固定でも動くが、プロキシ越しを考慮して実際のURLを検出
function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString().split(",")[0];
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`; // 例: https://www.nurserysera.com
}

// ====== DB（でーたべーす）接続 ======
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
    })
  : null;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-token"; // 管理トークン（とうくん）

// ====== アプリ本体 ======
const app = express();
app.set("trust proxy", true); // ぷろきし越しの https 検出
app.use(express.json({ limit: "5mb" }));

// CORS（こーず：他ドメイン許可）— 本番は www のみ許可
app.use(cors({
  origin: ["https://www.nurserysera.com"],
  credentials: true
}));

// ====== HTML 配信（public優先）。GASタグ置換もここで実施 ======
function candidateFiles(page) {
  // 探す順：1) public/page.html → 2) pages/page.html → 3) 直下/page.html
  return [
    path.join(PUBLIC_DIR, `${page}.html`),
    path.join(PAGES_DIR,  `${page}.html`),
    path.join(ROOT_DIR,   `${page}.html`)
  ];
}
function normalizePage(raw) {
  const s = String(raw || "index").trim().toLowerCase();
  return s.replace(/\.html$/i, "").replace(/[^a-z0-9-]/g, "") || "index";
}
function loadAndPatchHtml(filePath, baseUrl) {
  let html = fs.readFileSync(filePath, "utf8");
  // 1) GAS 宣言削除：<? var url = getScriptUrl(); ?>
  html = html.replace(/\<\?\s*var\s+url\s*=\s*getScriptUrl\(\);\s*\?\>/g, "");
  // 2) <?= url ?> → baseUrl に置換
  html = html.replace(/\<\?\=\s*url\s*\?\>/g, baseUrl);
  // 3) window.API_BASE を head 終了直前に注入（未定義なら）
  if (!/window\.API_BASE/.test(html)) {
    html = html.replace(/<\/head>/i, `<script>window.API_BASE='${baseUrl}/api';</script></head>`);
  }
  return html;
}
function renderPage(rawPage, req, res) {
  const page = normalizePage(rawPage);
  const baseUrl = getBaseUrl(req);
  for (const fp of candidateFiles(page)) {
    if (fs.existsSync(fp)) {
      const html = loadAndPatchHtml(fp, baseUrl);
      res.setHeader("Content-Type", "text/html; charset=UTF-8");
      return res.send(html);
    }
  }
  // 見つからない時は index.html にフォールバック（SPA的）
  for (const fp of candidateFiles("index")) {
    if (fs.existsSync(fp)) {
      const html = loadAndPatchHtml(fp, baseUrl);
      res.setHeader("Content-Type", "text/html; charset=UTF-8");
      return res.send(html);
    }
  }
  return res.status(404).send("Not Found: no html found");
}

// .html 付きURL（/index.html など）
app.get(/^\/([a-z0-9-]+)\.html$/i, (req, res) => {
  return renderPage(req.params[0], req, res);
});
// /?page=index 形式
app.get("/", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/assets")) return next();
  const page = req.query.page || "index";
  return renderPage(page, req, res);
});
// /index /cart など（/api は除外）
app.get(/^\/(?!api\/)([a-z0-9-]+)?$/i, (req, res) => {
  const page = req.params[0] || "index";
  return renderPage(page, req, res);
});

// 静的ファイル（画像/CSS/JS等）は public から直配信（/assets など任意パス）
app.use("/assets", express.static(path.join(PUBLIC_DIR))); // 例: /assets/img/logo.png

// ====== API（えーぴーあい）ここから ======
// ヘルスチェック（へるす：生存確認）
app.get("/api/health", (_, res) => res.json({ ok: true }));

// 商品一覧（DB未接続なら空配列）
app.get("/api/products", async (_, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});

// 商品の簡易追加（管理用）※ADMIN_TOKEN が一致しないと 401
app.post("/api/products/quick-add", async (req, res) => {
  if (req.body?.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  if (!pool) return res.status(500).json({ error: "DATABASE_URL not set (DB not available)" });

  const { name, price, imageUrl, category, sku } = req.body || {};
  const q = `INSERT INTO products(name, price, image_url, category, sku)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`;
  const { rows } = await pool.query(q, [name, price, imageUrl, category || null, sku || null]);
  res.json(rows[0]);
});

// 注文（ちゅうもん）作成
app.post("/api/orders", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });

  const { customer, note, items } = req.body || {};
  // お客さま登録
  const c = await pool.query(
    "INSERT INTO customers(name,email,address) VALUES ($1,$2,$3) RETURNING id",
    [customer.name, customer.email, customer.address]
  );
  const customerId = c.rows[0].id;

  // 合計（ごうけい）計算
  const total = (items || []).reduce((s, it) => s + Number(it.unitPrice || 0) * Number(it.quantity || 1), 0);

  // 注文作成
  const o = await pool.query(
    "INSERT INTO orders(customer_id, note, total_amount) VALUES ($1,$2,$3) RETURNING id",
    [customerId, note || null, total]
  );
  const orderId = o.rows[0].id;

  // 明細登録
  for (const it of items || []) {
    await pool.query(
      "INSERT INTO order_items(order_id, product_id, product_name, unit_price, quantity) VALUES ($1,$2,$3,$4,$5)",
      [orderId, it.productId || null, it.productName, it.unitPrice, it.quantity]
    );
  }

  // 自動返信メール（Brevo：ぶれぼ）
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

// 入金反映（にゅうきん・はんえい）
app.put("/api/orders/:id/paid", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  await pool.query("UPDATE orders SET is_paid = TRUE WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// 集計（カテゴリ別・全体）
app.get("/api/reports/category", async (_, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query("SELECT * FROM v_category_summary ORDER BY total_qty DESC");
  res.json(rows);
});
app.get("/api/reports/all", async (_, res) => {
  if (!pool) return res.json({ total_amount: 0, total_orders: 0 });
  const { rows } = await pool.query("SELECT * FROM v_all_total");
  res.json(rows[0] || { total_amount: 0, total_orders: 0 });
});

// ====== 起動 ======
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`App running on :${port}`));