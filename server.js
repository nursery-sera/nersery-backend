// server.js — public優先 + API（orders_all 1テーブル方式）
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

// 管理トークン（必要に応じて）
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

// ====== 注文作成（orders_all 1テーブル方式） ======
app.post("/api/orders", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });

  const { customer = {}, note, items = [], summary } = req.body || {};

  // 氏名
  const name =
    [customer.lastName, customer.firstName].filter(Boolean).join(" ").trim() ||
    (customer.name || "").trim();
  if (!name) return res.status(400).json({ error: "customer name required" });

  // 住所
  const addressFull =
    (customer.addressFull && String(customer.addressFull).trim()) ||
    [customer.prefecture, customer.city, customer.address, customer.building]
      .filter(Boolean).join("").trim() ||
    (customer.address || "");

  // 金額
  const subtotal = items.reduce((s, it) => s + Number(it.unitPrice || 0) * Number(it.quantity || 1), 0);
  const shipping = Number(summary?.shipping ?? 0);
  const shippingOptionAdd = Number(summary?.shippingOptionAdd ?? 0);
  const total = Number(summary?.total ?? (subtotal + shipping + shippingOptionAdd));
  const paymentMethod = String(summary?.paymentMethod || "bank_transfer");

  // 注文トークン
  const orderToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  if (!items.length) return res.status(400).json({ error: "no items" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const sql = `
      INSERT INTO orders_all (
        last_name, first_name, last_kana, first_kana,
        zipcode, prefecture, city, address, building, email,
        name, address_full,
        note, subtotal, shipping, shipping_option_add, total, payment_method,
        is_paid, status, order_token,
        product_id, product_name, unit_price, quantity,
        product_slug, image, category, variety,
        source, raw_payload
      )
      VALUES (
        $1,$2,$3,$4,
        $5,$6,$7,$8,$9,$10,
        $11,$12,
        $13,$14,$15,$16,$17,$18,
        FALSE,'pending',$19,
        $20,$21,$22,$23,
        $24,$25,$26,$27,
        'web',$28
      ) RETURNING id
    `;

    for (const it of items) {
  const rawPid = it.productId ?? null;
  const pid = /^\d+$/.test(String(rawPid)) ? Number(rawPid) : null;

  // サーバ側で productName を合成（カテゴリ＋バリエティーを優先。無いときは来ている値を順に採用）
  const clean = (s) => String(s || "").trim().replace(/\s+/g, " ");
const productName =
  (it?.category && it?.variety) ? `${clean(it.category)} ${clean(it.variety)}` :
  clean(it?.productName) || clean(it?.variety) || clean(it?.category);

  const params = [
    customer.lastName || "", customer.firstName || "",
    customer.lastKana || "", customer.firstKana || "",
    customer.zipcode || "", customer.prefecture || "",
    customer.city || "", (customer.address || ""), (customer.building || ""),
    customer.email || "",
    name, addressFull,
    note || null, subtotal, shipping, shippingOptionAdd, total, paymentMethod,
    orderToken,
    pid,
    productName,
    Number(it.unitPrice || 0),
    Number(it.quantity || 1),
    (it.productSlug || null),
    (it.image || null),
    (it.category || null),
    (it.variety || null),
    JSON.stringify(req.body || {})
  ];
  await client.query(sql, params);
}

    await client.query("COMMIT");

    // ----- Brevo 自動返信（任意） -----
    if (process.env.BREVO_API_KEY && customer.email) {
      const baseUrl = getBaseUrl(req);
      const subject = `ご注文ありがとうございます（#${orderToken}）`;
      const html = `
        <p>${name} 様</p>
        <p>ご注文（#${orderToken}）を受け付けました。</p>
        <p><strong>合計：¥${total.toLocaleString()}</strong></p>
        <p>お支払い方法：銀行振込</p>
        <p>※ご入金確認後に発送いたします。</p>
        <p><a href="${baseUrl}">nursery sera</a></p>
      `;
      try {
        const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "api-key": process.env.BREVO_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            sender: {
              email: process.env.MAIL_FROM || "info@example.com",
              name : process.env.MAIL_NAME || "nursery sera"
            },
            to: [{ email: customer.email, name }],
            subject,
            htmlContent: html
          })
        });
        if (!resp.ok) console.error("Brevo error:", await resp.text());
      } catch (e) {
        console.error("Brevo error:", e);
      }
    }
    // -----------------------------------

    res.json({ orderToken, total });
  } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "server error" });
  } finally {
    client.release();
  }
});

// 入金反映（トークンで全行更新）→ order_units も一括更新に拡張
app.put("/api/orders/:token/paid", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  const { token } = req.params;
  await pool.query(
    "UPDATE orders_all SET is_paid = TRUE, paid_at = now() WHERE order_token = $1",
    [token]
  );
  // 既存互換のまま残す（/api/orders 用）
  res.json({ ok: true });
});

// ====== 起動 ======
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`App running on :${port}`));

// ===== 管理API用の超シンプル認証 =====
function adminAuth(req, res, next) {
  const token = req.headers["x-admin-token"] || req.query.token;
  if (!ADMIN_TOKEN || token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: "unauthorized" });
}

// ===== 管理：注文一覧（クイック表示用のビューを返す） =====
app.get("/api/admin/orders", adminAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    const sql = req.query.paid === "1"
      ? "SELECT * FROM v_order_quick_paid ORDER BY created_at DESC"
      : "SELECT * FROM v_order_quick ORDER BY created_at DESC";
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ===== 管理：ある注文（order_token）の明細 =====
app.get("/api/admin/orders/:token/items", adminAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    const { token } = req.params;
    const { rows } = await pool.query(
      `SELECT product_name, unit_price, quantity
         FROM orders_all
        WHERE order_token = $1
        ORDER BY product_name`,
      [token]
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ===== 管理：支払いフラグの更新（チェックON/OFF：注文単位） =====
// ← ここを order_units も一括更新するよう拡張
app.put("/api/admin/orders/:token/paid", adminAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    const { token } = req.params;
    const paid = !!req.body?.paid;
    await pool.query(
      `UPDATE orders_all
          SET is_paid = $1,
              paid_at = CASE WHEN $1 THEN now() ELSE NULL END,
              status = CASE WHEN $1 THEN 'paid' ELSE 'pending' END
        WHERE order_token = $2`,
      [paid, token]
    );
    // ★ 追加：単株テーブルも一括更新
    await pool.query(
      `UPDATE order_units
          SET is_paid = $1,
              paid_at = CASE WHEN $1 THEN now() ELSE NULL END
        WHERE order_token = $2`,
      [paid, token]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ===== 管理：実トークン索引（name+address_full -> real order_token） =====
app.get("/api/admin/token-index", adminAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    const sql = `
      WITH base AS (
        SELECT
          COALESCE(NULLIF(name,''), CONCAT_WS(' ', NULLIF(last_name,''), NULLIF(first_name,''))) AS name_key,
          COALESCE(
            NULLIF(address_full,''),
            CONCAT_WS('',
              NULLIF(prefecture,''),
              NULLIF(city,''),
              COALESCE(address,''),
              COALESCE(building,'')
            )
          ) AS address_full_norm,
          email,
          order_token,
          created_at
        FROM orders_all
      ),
      ranked AS (
        SELECT
          name_key, address_full_norm, email, order_token, created_at,
          ROW_NUMBER() OVER (PARTITION BY name_key, address_full_norm ORDER BY created_at DESC) AS rn
        FROM base
      )
      SELECT
        name_key            AS name,
        address_full_norm   AS address_full,
        email,
        order_token,
        created_at
      FROM ranked
      WHERE rn = 1
      ORDER BY created_at DESC;
    `;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ===== 管理：任意ビューを返す汎用API =====
app.get("/api/view/:name", adminAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    const n = String(req.params.name || '').trim();
    const mapPaid = {};
    const paid = req.query.paid === '1';
    const viewName = paid && mapPaid[n] ? mapPaid[n] : n;
    if (!/^v_[a-z0-9_]+$/.test(viewName)) {
      return res.status(400).json({ error: "invalid view name" });
    }
    const sql = `SELECT * FROM ${viewName}`;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ===== 単株：支払い更新（1株単位） =====
app.put("/api/admin/unit/:id/paid", adminAuth, async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    const { id } = req.params;
    const paid = !!req.body?.paid;
    await pool.query(
      `UPDATE order_units
         SET is_paid = $1,
             paid_at = CASE WHEN $1 THEN now() ELSE NULL END
       WHERE id = $2`,
      [paid, id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ===== 単株：集計（トークン別：全株/支払株数） =====
app.get("/api/admin/units/summary-token", adminAuth, async (_req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    const sql = `
      SELECT
        order_token,
        COUNT(*)                        AS total_units,
        COUNT(*) FILTER (WHERE is_paid) AS paid_units
      FROM order_units
      GROUP BY order_token
    `;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});

// ===== 単株：集計（品種別：支払株数/金額） =====
app.get("/api/admin/units/summary-product", adminAuth, async (_req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    const sql = `
      SELECT
        oa.product_name,
        COUNT(u.id) FILTER (WHERE u.is_paid)                                      AS paid_qty,
        COALESCE(SUM(CASE WHEN u.is_paid THEN oa.unit_price ELSE 0 END), 0)::bigint AS paid_amount
      FROM order_units u
      JOIN orders_all oa ON oa.id = u.orders_all_id
      GROUP BY oa.product_name
      ORDER BY oa.product_name
    `;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "server error" });
  }
});