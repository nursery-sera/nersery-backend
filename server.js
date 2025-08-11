import express from "express";
import cors from "cors";
import { Pool } from "pg";

// === 設定（Railwayの環境変数を使う） ===
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DB_SSL === "true" ? { rejectUnauthorized: false } : false
});
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "dev-token";

// === サーバ起動 ===
const app = express();
app.use(cors());                          // CORS（こーす：他サイトからのアクセス許可）
app.use(express.json({ limit: "5mb" }));  // JSON受信

app.get("/api/health", (_, res) => res.json({ ok: true }));

// === 商品 ===
// 一覧
app.get("/api/products", async (_, res) => {
  const { rows } = await pool.query("SELECT * FROM products ORDER BY id DESC");
  res.json(rows);
});
// 簡易追加（ChatGPT/管理画面用）
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
  // 顧客
  const c = await pool.query(
    "INSERT INTO customers(name,email,address) VALUES ($1,$2,$3) RETURNING id",
    [customer.name, customer.email, customer.address]
  );
  const customerId = c.rows[0].id;

  // 合計計算
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

  // Brevo（ぶれぼ：自動返信メール）送信
  if (process.env.BREVO_API_KEY) {
    const body = {
      sender: { email: process.env.MAIL_FROM || "info@example.com", name: process.env.MAIL_NAME || "nursery sera" },
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
    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": process.env.BREVO_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!resp.ok) {
      console.error("Brevo error:", await resp.text()); // 失敗しても注文は通す
    }
  }

  res.json({ orderId, total });
});

// 入金反映
app.put("/api/orders/:id/paid", async (req, res) => {
  await pool.query("UPDATE orders SET is_paid = TRUE WHERE id = $1", [req.params.id]);
  res.json({ ok: true });
});

// === 集計 ===
app.get("/api/reports/category", async (_, res) => {
  const { rows } = await pool.query("SELECT * FROM v_category_summary ORDER BY total_qty DESC");
  res.json(rows);
});
app.get("/api/reports/all", async (_, res) => {
  const { rows } = await pool.query("SELECT * FROM v_all_total");
  res.json(rows[0]);
});

// === Listen ===
const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`API on :${port}`));
