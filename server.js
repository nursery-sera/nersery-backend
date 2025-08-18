// server.js — public優先 + API（全部入り）
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ===== pg 接続（Railway/環境変数対応） =====
import pkg from "pg";
const { Pool } = pkg;

// __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ====== 設定 ======
const ROOT_DIR   = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const PAGES_DIR  = path.join(ROOT_DIR, "pages");

// 実際のベースURL検出（プロキシ考慮）
function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString().split(",")[0];
  const host  = req.headers["x-forwarded-host"]  || req.get("host");
  return `${proto}://${host}`;
}

// ---- DB接続設定（Railway Variables か DATABASE_URL のどちらでもOK）----
function cfgFromPgVars() {
  const { PGHOST, PGUSER, PGPASSWORD, PGDATABASE, PGPORT } = process.env;
  if (!PGHOST || !PGUSER || !PGDATABASE) return null;
  return {
    host: PGHOST,
    user: PGUSER,
    password: PGPASSWORD,
    database: PGDATABASE,
    port: PGPORT ? Number(PGPORT) : 5432,
    ssl: { rejectUnauthorized: false }, // Railwayは基本SSL必須
  };
}

let pool;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === "false" ? false : { rejectUnauthorized: false },
  });
} else {
  const cfg = cfgFromPgVars();
  pool = cfg ? new Pool(cfg) : null;
}

// 管理トークン
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-token";

// ====== アプリ本体 ======
const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "5mb" }));
app.use(cors({
  origin: ["https://www.nurserysera.com"],
  credentials: true
}));

// ====== HTML 配信（public優先）。GASタグ置換もここで実施 ======
function candidateFiles(page) {
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
  // GAS置換
  html = html.replace(/\<\?\s*var\s+url\s*=\s*getScriptUrl\(\);\s*\?\>/g, "");
  html = html.replace(/\<\?\=\s*url\s*\?\>/g, baseUrl);
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
  for (const fp of candidateFiles("index")) {
    if (fs.existsSync(fp)) {
      const html = loadAndPatchHtml(fp, baseUrl);
      res.setHeader("Content-Type", "text/html; charset=UTF-8");
      return res.send(html);
    }
  }
  return res.status(404).send("Not Found: no html found");
}

app.get(/^\/([a-z0-9-]+)\.html$/i, (req, res) => renderPage(req.params[0], req, res));
app.get("/", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/assets")) return next();
  const page = req.query.page || "index";
  return renderPage(page, req, res);
});
app.get(/^\/(?!api\/)([a-z0-9-]+)?$/i, (req, res) => {
  const page = req.params[0] || "index";
  return renderPage(page, req, res);
});
app.use("/assets", express.static(path.join(PUBLIC_DIR)));

// ====== API ======
app.get("/api/health", (_, res) => res.json({ ok: true }));

app.get("/api/products", async (_, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});

app.post("/api/products/quick-add", async (req, res) => {
  if (req.body?.token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  if (!pool) return res.status(500).json({ error: "DATABASE_URL not set (DB not available)" });

  const { name, price, imageUrl, category, sku } = req.body || {};
  const q = `INSERT INTO products(name, price, image_url, category, sku)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`;
  const { rows } = await pool.query(q, [name, price, imageUrl, category || null, sku || null]);
  res.json(rows[0]);
});

// ====== 注文作成 ======
app.post("/api/orders", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });

  try {
    const { customer = {}, note, items = [], summary } = req.body || {};

    // 姓名の結合（customer.name があればそれも許可）
    const name =
      [customer.lastName, customer.firstName].filter(Boolean).join(" ").trim() ||
      (customer.name || "").trim();

    // 住所の結合（address / addressFull / 各フィールド結合）
    const address =
      (customer.address && String(customer.address).trim()) ||
      (customer.addressFull && String(customer.addressFull).trim()) ||
      [customer.prefecture, customer.city, customer.address, customer.building]
        .filter(Boolean).join("").trim() || null;

    if (!name) {
      return res.status(400).json({ error: "customer name required" });
    }

    // お客さま登録
    const c = await pool.query(
      "INSERT INTO customers(name,email,address) VALUES ($1,$2,$3) RETURNING id",
      [name, customer.email || null, address]
    );
    const customerId = c.rows[0].id;

    // 小計
    const itemsSubtotal = (items || []).reduce(
      (s, it) => s + Number(it.unitPrice || 0) * Number(it.quantity || 1),
      0
    );
    // 返却用の総額（送料・オプション込）
    const grandTotal = summary?.total ?? itemsSubtotal;

    // 注文作成（DBは小計で保存）
    const o = await pool.query(
      "INSERT INTO orders(customer_id, note, total_amount) VALUES ($1,$2,$3) RETURNING id",
      [customerId, note || null, itemsSubtotal]
    );
    const orderId = o.rows[0].id;

    // 明細（productId が数値でなければ NULL にして挿入）
    for (const it of items || []) {
      const pid = /^\d+$/.test(String(it.productId)) ? Number(it.productId) : null;
      await pool.query(
        `INSERT INTO order_items
           (order_id, product_id, product_name, unit_price, quantity)
         VALUES ($1,$2,$3,$4,$5)`,
        [orderId, pid, it.productName, it.unitPrice, it.quantity]
      );
    }

    // 自動返信メール（任意）
    if (process.env.BREVO_API_KEY) {
      const body = {
        sender: {
          email: process.env.MAIL_FROM || "info@example.com",
          name: process.env.MAIL_NAME || "nursery sera"
        },
        to: [{ email: customer.email, name }],
        subject: `ご注文ありがとうございます（#${orderId}）`,
        htmlContent: `
          <p>${name} 様</p>
          <p>ご注文（#${orderId}）を受け付けました。</p>
          <p>合計：${grandTotal.toLocaleString()}円</p>
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

    res.json({ orderId, total: grandTotal });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server error" });
  }
});

// 入金反映
app.put("/api/orders/:id/paid", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  await pool.query("UPDATE orders SET is_paid = TRUE WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// レポート
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