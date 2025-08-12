import express from "express";
import cors from "cors";
import { Pool } from "pg";

// === 設定（Railwayの環境変数） ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-token";

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ★ 静的配信：public配下のHTMLをそのまま配る
app.use(express.static("public", { extensions: ["html"] }));
// ★ ルートは index.html
app.get("/", (_, res) => res.sendFile("index.html", { root: "public" }));

// ヘルスチェック
app.get("/api/health", (_, res) => res.json({ ok: true }));

// === 商品 ===
app.get("/api/products", async (_, res) => {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});
app.post("/api/products/quick-add", async (req, res) => {
  const { token, name, price, imageUrl, category, sku } = req.body || {};
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: "unauthorized" });
  const q = `INSERT INTO products(name, price, image_url, category, sku)
             VALUES ($1,$2,$3,$4,$5) RETURNING *`;
  const { rows } = await pool.query(q, [name, price, imageUrl, category || null, sku || null]);
  res.json(rows[0]);
});

// === 注文 ===
app.post("/api/orders", async (req, res) => {
  const { customer, note, items } = req.body || {};

  // 顧客（name/email/address の簡易保存）
  const c = await pool.query(
    "INSERT INTO customers(name,email,address) VALUES ($1,$2,$3) RETURNING id",
    [
      `${customer.lastName || ""} ${customer.firstName || ""}`.trim(),
      customer.email,
      `${customer.zipcode || ""} ${customer.prefecture || ""}${customer.city || ""}${customer.address || ""} ${customer.building || ""}`.trim()
    ]
  );
  const customerId = c.rows[0].id;

  // 合計
  const total = (items || []).reduce((s, it) => s + Number(it.unitPrice||0) * Number(it.quantity||1), 0);

  // 注文
  const o = await pool.query(
    "INSERT INTO orders(customer_id, note, total_amount) VALUES ($1,$2,$3) RETURNING id",
    [customerId, note || null, total]
  );
  const orderId = o.rows[0].id;

  // 明細
  for (const it of items || []) {
    await pool.query(
      "INSERT INTO order_items(order_id, product_id, product_name, unit_price, quantity) VALUES ($1,$2,$3,$4,$5)",
      [orderId, it.productId || null, it.productName, it.unitPrice, it.quantity]
    );
  }

  // Brevo（自動返信メール）※失敗しても注文は通す
  if (process.env.BREVO_API_KEY) {
    const body = {
      sender: { email: process.env.MAIL_FROM || "info@example.com", name: process.env.MAIL_NAME || "nursery sera" },
      to: [{ email: customer.email, name: `${customer.lastName || ""} ${customer.firstName || ""}`.trim() }],
      subject: `ご注文ありがとうございます（#${orderId}）`,
      htmlContent: `
        <p>${(customer.lastName || "") + " " + (customer.firstName || "")} 様</p>
        <p>ご注文（#${orderId}）を受け付けました。</p>
        <p>合計：${total.toLocaleString()}円</p>
        <p>お支払い方法：銀行振込（PayPay銀行）</p>
        <p>※ご入金確認後に発送いたします。</p>
      `
    };
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!resp.ok) console.error("Brevo error:", await resp.text());
  }

  res.json({ orderId, total });
});

// 入金反映
app.put("/api/orders/:id/paid", async (req, res) => {
  await pool.query("UPDATE orders SET is_paid = TRUE WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// 集計
app.get("/api/reports/category", async (_, res) => {
  const { rows } = await pool.query("SELECT * FROM v_category_summary ORDER BY total_qty DESC");
  res.json(rows);
});
app.get("/api/reports/all", async (_, res) => {
  const { rows } = await pool.query("SELECT * FROM v_all_total");
  res.json(rows[0]);
});

// === DB 初期化（初回だけ実行される想定） ===
async function initDb() {
  const sql = `
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  price INTEGER NOT NULL,
  image_url TEXT,
  category TEXT,
  sku TEXT,
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS customers (
  id SERIAL PRIMARY KEY,
  name TEXT,
  email TEXT,
  address TEXT,
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  note TEXT,
  total_amount INTEGER NOT NULL,
  is_paid BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  id SERIAL PRIMARY KEY,
  order_id INTEGER REFERENCES orders(id),
  product_id INTEGER REFERENCES products(id),
  product_name TEXT,
  unit_price INTEGER,
  quantity INTEGER,
  created_at TIMESTAMP DEFAULT now()
);
CREATE OR REPLACE VIEW v_category_summary AS
SELECT COALESCE(p.category,'(未分類)') AS category,
       SUM(oi.quantity) AS total_qty,
       SUM(oi.unit_price*oi.quantity) AS total_amount
FROM order_items oi
LEFT JOIN products p ON p.id = oi.product_id
GROUP BY COALESCE(p.category,'(未分類)');
CREATE OR REPLACE VIEW v_all_total AS
SELECT SUM(oi.unit_price*oi.quantity) AS grand_total
FROM order_items oi;`;
  await pool.query(sql);
  console.log("DB initialized");
}

// Listen（初期化後に待ち受け）
await initDb();
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API on :${port}`));
