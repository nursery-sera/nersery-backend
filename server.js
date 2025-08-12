// server.js
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Pool } from "pg";

// __dirname 相当（ESM）
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== DB（必要なら使う。未設定ならスキップでOK）======
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
    })
  : null;

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-token";

// ====== App ======
const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// 静的ファイル（/public 配下）※必要なら使う
app.use("/public", express.static(path.join(__dirname, "public")));

// ====== HTMLテンプレート配信（GAS互換）======
//   - 1本のURLで  /?page=index みたいに出し分け
//   - HTML内の「<? var url = getScriptUrl(); ?>」「<?= url ?>」をサーバで差し込み
//   - window.API_BASE も head 内に自動注入
app.get("/", (req, res) => {
  const host = req.get("host");
  const baseUrl = `${req.protocol}://${host}`; // GASの getScriptUrl() 相当
  const page = String(req.query.page || "index").replace(/[^a-z]/g, ""); // 安全のため英字のみ許可
  const file = path.join(__dirname, "pages", `${page}.html`);
  if (!fs.existsSync(file)) {
    return res.status(404).send("Not Found");
  }

  let html = fs.readFileSync(file, "utf8");

  // GASテンプレタグを置換
  // <? var url = getScriptUrl(); ?> は不要なので消す（GASでの宣言部）
  html = html.replace(/\<\?\s*var\s+url\s*=\s*getScriptUrl\(\);\s*\?\>/g, "");
  // <?= url ?> を baseUrl に差し込み
  html = html.replace(/\<\?\=\s*url\s*\?\>/g, baseUrl);

  // <base target="_top"> がある前提のままでOK（相対遷移は window.top.location.href='<?= url ?>?...' で動く）
  // window.API_BASE を <head> 終了直前に注入（未記載でもAPIを叩けるようにする）
  if (!/window\.API_BASE/.test(html)) {
    html = html.replace(
      /<\/head>/i,
      `<script>window.API_BASE = '${baseUrl}/api';</script></head>`
    );
  }

  res.setHeader("Content-Type", "text/html; charset=UTF-8");
  res.send(html);
});

// ====== API（必要な人だけ使う。未設定でも表示はできる）======
// ヘルスチェック
app.get("/api/health", (_, res) => res.json({ ok: true }));

// 商品一覧（DB未設定なら空配列返す）
app.get("/api/products", async (_, res) => {
  if (!pool) return res.json([]);
  const { rows } = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});

// 商品の簡易追加（ChatGPT/管理画面用）
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

// 注文
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

  for (const it of items || []) {
    await pool.query(
      "INSERT INTO order_items(order_id, product_id, product_name, unit_price, quantity) VALUES ($1,$2,$3,$4,$5)",
      [orderId, it.productId || null, it.productName, it.unitPrice, it.quantity]
    );
  }

  // Brevo で自動返信（設定があれば）
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

// 入金反映
app.put("/api/orders/:id/paid", async (req, res) => {
  if (!pool) return res.status(500).json({ error: "DB not available" });
  await pool.query("UPDATE orders SET is_paid = TRUE WHERE id = $1", [
    req.params.id
  ]);
  res.json({ ok: true });
});

// 集計（DBなければ空）
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
  res.json(rows[0]);
});

// ====== Listen ======
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`App running on :${port}`));