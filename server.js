// server.js — public優先 + API（orders_all 1テーブル方式）
import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import nodemailer from "nodemailer";
// ★追加：古い Node でも fetch を使えるよう保険
if (typeof fetch !== 'function') {
  globalThis.fetch = async (...args) => {
    const { default: nodeFetch } = await import('node-fetch');
    return nodeFetch(...args);
  };
}

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
// ★SMTPトランスポート（SMTP接続設定）
const transporter = nodemailer.createTransport({
  host  : process.env.SMTP_HOST,                 // 例: mail1024.onamae.ne.jp
  port  : Number(process.env.SMTP_PORT || 587),  // お名前.comなら 465 が多い
  secure: process.env.SMTP_SECURE === "true" || Number(process.env.SMTP_PORT) === 465,
  auth  : {
    user: process.env.SMTP_USER,                 // 例: info@nurserysera.com
    pass: process.env.SMTP_PASS                  // メール(アプリ)パスワード
  }
});

// ===== Brevo: テンプレ送信（templateId + params） =====
async function sendBrevoTemplate(templateId, to, params) {
  if (!process.env.BREVO_API_KEY) throw new Error("BREVO_API_KEY not set");
  const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "api-key": process.env.BREVO_API_KEY,
      "content-type": "application/json",
      "accept": "application/json"
    },
    body: JSON.stringify({
      to: [{ email: to.email, name: to.name }],
      templateId: Number(templateId),
      params
    })
  });
  const text = await resp.text();
  let json; try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!resp.ok) throw new Error(`brevo:${resp.status} ${JSON.stringify(json)}`);
  return json?.messageId || null;
}
// ===== 改行→<br> に変換（メールHTML用） =====
function escapeHtml(s='') {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}
// HTMLタグはそのまま通し、改行だけ <br> に変換する
function toHtmlLines(s='') {
  return String(s).replace(/\r\n|\r|\n/g, '<br>');
}

// ===== 改行を <br> に変換する専用ヘルパー =====
function nl2br(str = '') {
  return String(str).replace(/\r\n|\r|\n/g, '<br>');
}

// ===== 注文明細ブロック（メール本文に差し込む） =====
function buildOrderDetailBlockFromRows(rows) {
  const yen = (n) => `¥${Number(n||0).toLocaleString('ja-JP')}`;
  const first = rows[0];
  if (!first) return '';

  // 商品行
  const itemsText = rows.map(r => {
    const nm = (r.category && r.variety)
      ? `${r.category} ${r.variety}`
      : (r.product_name || r.variety || r.category || '商品');
    const qty  = Number(r.quantity||1);
    const unit = yen(r.unit_price);
    const line = yen(Number(r.unit_price||0) * qty);
    return `・${nm}　${unit} × ${qty} = ${line}`;
  }).join('\n');

  // 金額類
  const subtotal = rows.reduce((s,r)=> s + Number(r.unit_price||0)*Number(r.quantity||1), 0);
  const shipping = Number(first?.shipping || 0);
  const total    = Number(first?.total ?? (subtotal + shipping));

  // 住所/氏名
  const addr = first?.address_full
    || [first?.prefecture, first?.city, first?.address, first?.building].filter(Boolean).join('');
  const customerName =
    first?.customer_name
    || first?.name
    || [first?.last_name, first?.first_name].filter(Boolean).join(' ').trim();

  // 日時
  const created = new Date(first?.created_at || Date.now())
    .toLocaleString('ja-JP', { timeZone:'Asia/Tokyo' });

  return `
────────────────────────
【ご注文内容】

${itemsText}

小計：${yen(subtotal)}
配送方法：${first?.shipping_option_text || ''}（送料 ${yen(shipping)}）
合計：${yen(total)}

────────────────────────

■ ご注文情報
・注文番号：${first?.order_token}
・ご注文日時：${created}
・お名前：${customerName} 様
・ご住所：${addr}
・メールアドレス：${first?.email}
${first?.note ? `・備考：${first.note}` : ''}



■ 配送先情報
・お名前：${customerName} 様
・ご住所：${addr}
・電話番号：${first?.phone || ''}



■ お問い合わせ
お問い合わせページ:https://www.nurserysera.com/policy.html
メール：${process.env.SUPPORT_EMAIL || process.env.MAIL_FROM || 'info@nurserysera.com'}
LINE https://lin.ee/mFSu5FS
Instagram https://www.instagram.com/nursery_sera?igsh=cWx2cTZ3cWNicGlz&utm_source=
`.trim();
}

// ===== email_events: 予約→確定ユーティリティ =====
async function reserveEmail(pool, orderToken, eventType, actor='system') {
  const r = await pool.query(
    `INSERT INTO email_events(order_token, event_type, status, attempts)
     VALUES ($1,$2,'reserved',0)
     ON CONFLICT (order_token, event_type) DO NOTHING
     RETURNING id`,
    [orderToken, eventType]
  );
  return r.rowCount ? r.rows[0].id : null;
}
async function finishEmailOk(pool, eventId, messageId) {
  await pool.query(
    `UPDATE email_events
       SET status='sent', attempts=attempts+1, provider_message_id=$1, sent_at=NOW()
     WHERE id=$2`,
    [messageId || null, eventId]
  );
}
async function finishEmailFail(pool, orderToken, eventType, errText) {
  await pool.query(
    `UPDATE email_events
       SET status='failed', attempts=attempts+1, error=$3
     WHERE order_token=$1 AND event_type=$2`,
    [orderToken, eventType, String(errText).slice(0, 800)]
  );
}
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
  const total = Number(summary?.total ?? (subtotal + shipping));
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
    phone,                             -- ★追加
    name, address_full,
    note, subtotal, shipping, shipping_option_text, total, payment_method,
    is_paid, status, order_token,
    product_id, product_name, unit_price, quantity,
    product_slug, image, category, variety,
    source, raw_payload
  )
  VALUES (
    $1,$2,$3,$4,
    $5,$6,$7,$8,$9,$10,
    $11,                -- ★phone
    $12,$13,
    $14,$15,$16,$17,$18,$19,
    FALSE,'pending',$20,
    $21,$22,$23,$24,
    $25,$26,$27,$28,
    'web',$29
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
    customer.phone || "",
    name, addressFull,
    note || null,
    subtotal,
    shipping,
    String(summary?.shippingOptionText ?? '') || null, // ★配送方法（文字）
    total,
    paymentMethod,
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
    const r = await client.query(sql, params);
  const ordersAllId = r.rows[0].id;

  // ★ 受け取った id を使って単株を quantity 分作成
  await client.query(
    `INSERT INTO order_units (orders_all_id, order_token, unit_no, is_paid)
       SELECT $1, $2, gs, FALSE
         FROM generate_series(1, $3) AS gs`,
    [ordersAllId, orderToken, Number(it.quantity || 1)]
  );
}

    await client.query("COMMIT");

 // ----- Brevo 自動返信（任意） -----
console.log(
  "BREVO?", !!process.env.BREVO_API_KEY,
  "MAIL_FROM?", !!process.env.MAIL_FROM,
  "customer.email?", !!customer.email
);

// ----- Brevo 自動返信（変更後：詳細本文） -----
let emailSent = false;
let brevoInfo = null;

if (process.env.BREVO_API_KEY && customer.email) {
  try {
    // ユーティリティ
    const yen = (n) => `¥${Number(n || 0).toLocaleString('ja-JP')}`;
    const esc = (s) => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    // 表示用の各値
    const display = {
      customer_name: name,
      customer_name_kana: [customer.lastKana, customer.firstKana].filter(Boolean).join(' '),
      shipping_address:
        (customer.addressFull && String(customer.addressFull)) ||
        [customer.prefecture, customer.city, customer.address, customer.building].filter(Boolean).join(''),
      email: customer.email,
      phone: customer.phone || '',
      order_id: orderToken,
      order_datetime: new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      items: items.map(it => {
  const clean = (s) => String(s || "").trim(); // 空白除去
  const productName =
    (it?.category && it?.variety)
      ? `${clean(it.category)} ${clean(it.variety)}`
      : clean(it.productName) || clean(it.variety) || clean(it.category) || "商品";

  return {
    productName,  // ← カテゴリ＋バリエティに統一
    quantity: Number(it.quantity || 1),
    unit_price: yen(it.unitPrice),
    line_total: yen(Number(it.unitPrice || 0) * Number(it.quantity || 1)),
  };
}),
      subtotal: yen(subtotal),
      shipping_name: String(summary?.shippingOptionText ?? ''),
      shipping_cost: yen(shipping),
      total: yen(total),
      note: note || '',
      // 口座情報（環境変数が無い場合は空でOK）
      bank_branch: process.env.BANK_BRANCH || '',
      bank_account_number: process.env.BANK_ACCOUNT_NUMBER || '',
      bank_account_holder: process.env.BANK_ACCOUNT_HOLDER || '',

      // 期日・案内
      payment_due_date: new Date(Date.now() + 3*24*60*60*1000)
        .toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo' }),
      estimated_ship_window: process.env.ESTIMATED_SHIP_WINDOW || '',

      support_email: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM || 'info@nurserysera.com',
    };

    // テキスト本文
    const textBody = (
`${display.customer_name} 様

このたびは Nursery Sera にご注文いただき、誠にありがとうございます。
以下の内容でご注文を受け付けいたしました。

お手数ではございますが、下記のご案内に沿ってお振込のお手続きをお願いいたします。
ご入金の確認が取れ次第、輸入の手続きを進めさせていただきます。

なお、当店では毎日17時00分頃に入金確認を行っております。
ご入金の確認ができましたら、改めてメールにてご案内させていただきます。
※年末年始（12/31〜1/3）は金融機関休業のため、
入金確認は1/4以降となります。

────────────────────────
【ご注文内容】

${display.items.map(it =>
  `・${it.productName}　${it.unit_price}  × ${it.quantity} = ${it.line_total} `
).join('\n')}

小計：${display.subtotal}  
配送方法：${display.shipping_name}（送料 ${display.shipping_cost}）  
合計：${display.total}

────────────────────────
【お振込先】

銀行名：PayPay銀行
支店名：ビジネス営業部
口座種別：普通
口座番号：1159273
口座名義：Nursery Sera Nakanishi Masaya
お振込期限：1月4日（期限までのご入金をお願いいたします）
────────────────────────


■ ご注文情報
・注文番号：${display.order_id}  
・ご注文日時：${display.order_datetime}  
・お名前：${display.customer_name} 様  
・お名前（フリガナ）：${display.customer_name_kana} 様  
・ご住所：${display.shipping_address}  
・メールアドレス：${display.email}
${note && note.trim() ? `・備考：${note}` : ''}


■ 配送先情報
・お名前：${display.customer_name} 様  
・ご住所：${display.shipping_address}
・電話番号：${display.phone}

■ お支払い方法
銀行振込

■ 発送予定
1月下旬〜2月上旬頃の発送を予定しております。  
※天候や輸入状況、植物到着時の検査などにより、発送時期が前後する場合がございます。  
詳細な日程が決まり次第、Nursery SeraよりメールやSNSにて随時ご連絡いたします。

■ 商品特性とお願い
・本商品は組織培養株です。お受け取り後は順化（培養環境から育成環境へ慣らす作業）をお願いいたします。  
・輸入後に当店で検品を行います。万一、著しい痛み等が確認された場合は迅速に返金対応いたします。  
・個体の選別はできず、発送株はランダムとなります。あらかじめご了承ください。  
・お届け先情報に誤りがあると配達できない場合があります。今一度ご確認ください。

■ お問い合わせ
メール：${display.support_email}

本メールは自動送信です。ご不明点や変更がある場合は、このメールにご返信いただくか、上記連絡先までご連絡ください。`
    ).trim();

  // HTML版（改行を <br> に変換）
const htmlBody = `
<div style="font:14px/1.8 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Noto Sans JP','Hiragino Kaku Gothic ProN',Meiryo,Arial,sans-serif;">
  ${nl2br(textBody)}
</div>`;
    // 件名
    const subject = `ご注文受付のお知らせ`;

    // Brevo 送信
    const payload = {
      sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_NAME || 'nursery sera' },
      to: [{ email: customer.email, name }],
      subject,
      htmlContent: htmlBody,
      textContent: textBody,
    };

    console.log('Brevo req →', { to: customer.email, subject });
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        'api-key': process.env.BREVO_API_KEY,
        'Content-Type': 'application/json',
        'accept': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const bodyText = await resp.text();
    let json;
    try {
      json = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      json = { raw: bodyText };
    }

    console.log('Brevo res ←', resp.status, json);

    if (resp.ok) {
      emailSent = true;
      brevoInfo = { status: resp.status, messageId: json?.messageId || null };
    } else {
      brevoInfo = { status: resp.status, error: json };
      console.error('Brevo error:', resp.status, json);
    }
  } catch (e) {
    brevoInfo = { status: 0, error: String(e) };
    console.error('Brevo error:', e);
  }
}
// ----- /Brevo （変更後） -----
res.json({ orderToken, total, emailSent, brevo: brevoInfo }); // ← 詳細を返す
   } catch (e) {
    await client.query("ROLLBACK");
    console.error(e);
    res.status(500).json({ error: "server error" });
  } finally {
    client.release();
  }
});
// ★修正：お問い合わせ送信（Brevoで直送、自動返信なし・あなた宛てだけ）
app.post("/api/contact", async (req, res) => {
  try {
    const { name, email, message } = req.body || {};
    if (!name || !email || !message) {
      return res.status(400).json({ error: "name, email, message are required" });
    }

    // 宛先（あなたに届く先）
    const to = process.env.CONTACT_TO || process.env.MAIL_FROM;

    // Brevo 送信ペイロード
    const payload = {
      sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_NAME || "nursery sera" },
      to: [{ email: to }],                        // ← あなた宛だけ
      subject: `【お問い合わせ】${name} 様`,
      textContent:
`お名前：${name}
メール：${email}

本文：
${message}
`,
      replyTo: { email, name }                    // ← 返信時はユーザーに返る
    };

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const bodyText = await resp.text();
    let bodyJson; try { bodyJson = bodyText ? JSON.parse(bodyText) : null; } catch { bodyJson = { raw: bodyText }; }

    if (!resp.ok) {
      console.error("Brevo contact error:", resp.status, bodyJson);
      return res.status(500).json({ ok: false, error: "mail send failed" });
    }

    console.log("Brevo contact sent:", bodyJson);
    return res.json({ ok: true });
  } catch (e) {
    console.error("contact error", e);
    return res.status(500).json({ ok: false, error: "mail send failed" });
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
  
  try {
    const eventId = await reserveEmail(pool, token, 'paid_notice', 'system');
    if (eventId && process.env.BREVO_TEMPLATE_PAID) {
      const headQ = await pool.query("SELECT * FROM v_order_quick WHERE order_token=$1", [token]);
      const rowsQ = await pool.query("SELECT * FROM orders_all    WHERE order_token=$1 ORDER BY id", [token]);
      if (headQ.rowCount) {
        const H = headQ.rows[0];
        const to = { email: H.email, name: H.customer_name || H.email };
  const params = {
  customer_name: to.name || "お客様",
  support_email: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM,
  order_detail_block_text: buildOrderDetailBlockFromRows(rowsQ.rows) // ← テキストのみ
};
        const mid = await sendBrevoTemplate(process.env.BREVO_TEMPLATE_PAID, to, params);
        await finishEmailOk(pool, eventId, mid);
      }
    }
  } catch (e) {
    await finishEmailFail(pool, token, 'paid_notice', e);
    console.error("paid_notice send error:", e);
  }

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
// 発送予定メール：未送候補（支払い済 & shipdate 未送）
// ※ ship日付はテーブルに保存しない運用 → 送信時に文字列で渡す前提
app.get("/api/admin/email-candidates/ship-date", adminAuth, async (_req, res) => {
  try {
    const sql = `
      SELECT DISTINCT ON (o.order_token)
        o.order_token, o.email,
        COALESCE(NULLIF(o.name,''), CONCAT_WS(' ', NULLIF(o.last_name,''), NULLIF(o.first_name,''))) AS customer_name
      FROM orders_all o
      WHERE o.is_paid = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM email_events e
           WHERE e.order_token = o.order_token
             AND e.event_type  = 'shipdate_notice'
            AND e.status      = 'sent'
        )
      ORDER BY o.order_token, o.id DESC`;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

// 発送完了メール：未送候補（支払い済 & tracking_noあり & 未送）
app.get("/api/admin/email-candidates/shipped", adminAuth, async (_req, res) => {
  try {
    const sql = `
      SELECT DISTINCT ON (o.order_token)
        o.order_token, o.email, o.shipping_option_text, o.tracking_no,
        COALESCE(NULLIF(o.name,''), CONCAT_WS(' ', NULLIF(o.last_name,''), NULLIF(o.first_name,''))) AS customer_name
      FROM orders_all o
      WHERE o.is_paid = TRUE
        AND NOT EXISTS (
          SELECT 1 FROM email_events e
           WHERE e.order_token = o.order_token
             AND e.event_type  = 'shipped_notice'
            AND e.status      = 'sent'
        )
      ORDER BY o.order_token, o.id DESC`;
    const { rows } = await pool.query(sql);
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});
// 追跡番号を保存（order_token 単位で全行更新）
app.post("/api/admin/set-tracking", adminAuth, async (req, res) => {
  // 1) DB接続が無ければ 500
  if (!pool) return res.status(500).json({ error: "DB not available" });
  try {
    // 2) 管理画面から渡された値を受け取る
    const token = String(req.body?.order_token || "").trim();   // ← 注文トークン
    const v     = String(req.body?.tracking_no  ?? "").trim();  // ← 追跡番号（空文字で消去OK）

    // 3) 必須チェック
    if (!token) return res.status(400).json({ error: "order_token required" });

    // 4) 同一 order_token の全行に tracking_no を一括反映
    const q = `
      UPDATE orders_all
         SET tracking_no = $2
       WHERE order_token = $1
    `;
    const r = await pool.query(q, [token, v]);

    // 5) 反映件数を返す（商品が複数行なら複数件になる）
    return res.json({ ok: true, updated: r.rowCount });
  } catch (e) {
    // 6) 予期せぬエラー
    console.error("set-tracking error", e);
    return res.status(500).json({ ok: false, error: "server error" });
  }
});
// body: { items: [{ order_token: "...", ship_date_text: "2025/09/20 ごろ" }, ...] }
app.post("/api/admin/send/ship-date", adminAuth, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "items required" });

    let ok = 0, errors = [];
    for (const it of items) {
   const token = String(it.order_token || '').trim();
const shipDateText = String(it.ship_date_text || '').trim();
// ここを緩和：token があればOK（ship_date_text は空文字OK）
if (!token) { errors.push({ token, reason: 'missing token' }); continue; }
      try {
        const eventId = await reserveEmail(pool, token, 'shipdate_notice', 'admin');
        if (!eventId) continue;

        const headQ = await pool.query("SELECT * FROM v_order_quick WHERE order_token=$1", [token]);
        const rowsQ = await pool.query("SELECT * FROM orders_all    WHERE order_token=$1 ORDER BY id", [token]);
        if (!headQ.rowCount) throw new Error("order not found");
        const H = headQ.rows[0];

        const to = { email: H.email, name: H.customer_name || H.email };
        const params = {
  customer_name: to.name || "お客様",
  support_email: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM,
  order_detail_block_text: buildOrderDetailBlockFromRows(rowsQ.rows),
  ship_date_text: shipDateText
};
        const mid = await sendBrevoTemplate(process.env.BREVO_TEMPLATE_SHIPDATE, to, params);
        await finishEmailOk(pool, eventId, mid);
        ok++;
      } catch (e) {
        await finishEmailFail(pool, token, 'shipdate_notice', e);
        errors.push({ token, reason: String(e) });
      }
    }
    res.json({ ok, ng_count: errors.length, errors });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
});

app.post("/api/admin/send/shipped", adminAuth, async (req, res) => {
  try {
    const tokens = Array.isArray(req.body?.order_tokens) ? req.body.order_tokens : [];
    if (!tokens.length) return res.status(400).json({ error: "order_tokens required" });

    let ok = 0, errors = [];
    for (const token of tokens) {
      try {
        const eventId = await reserveEmail(pool, token, 'shipped_notice', 'admin');
        if (!eventId) continue;

        const headQ = await pool.query("SELECT * FROM v_order_quick WHERE order_token=$1", [token]);
        const rowsQ = await pool.query("SELECT * FROM orders_all    WHERE order_token=$1 ORDER BY id", [token]);
        if (!headQ.rowCount) throw new Error("order not found");
        const H = headQ.rows[0];

        const shipMethod = H.shipping_option_text || '';
        const trackingNo = H.tracking_no || '';

        let trackingUrl = "";
        if (trackingNo) {
          const m = shipMethod;
          if (/ヤマト|クロネコ|宅急便/i.test(m)) {
            trackingUrl = `https://track.kuronekoyamato.co.jp/tracking?number=${encodeURIComponent(trackingNo)}`;
          } else if (/日本郵便|ゆうパック|ゆうメール|郵便/i.test(m)) {
            trackingUrl = `https://trackings.post.japanpost.jp/services/srv/search/direct?reqCodeNo1=${encodeURIComponent(trackingNo)}`;
          } else if (/佐川|SG/i.test(m)) {
            trackingUrl = `https://k2k.sagawa-exp.co.jp/p/sagawa/web/okurijoinput.jsp?okurijoNo=${encodeURIComponent(trackingNo)}`;
          }
        }

        // ここは () で全体をくくって最後に .trim() を付ける
const tracking_block = (
  trackingNo
    ? `━━━━━━━━━━━━━━━━━━
■ 発送日
　1月19日

■ お届け予定
通常、発送日から 1〜2 日程度でのお届けとなります。

■ 配送方法
${shipMethod}

■ 追跡番号
${trackingNo}

■ 追跡URL
${trackingUrl}
━━━━━━━━━━━━━━━━━━`
    : `━━━━━━━━━━━━━━━━━━
■ 発送日
　1月19日

■ 配送方法
${shipMethod}

■ 追跡番号
${trackingNo}

■ 追跡URL
${trackingUrl}

■ お届け予定
通常、発送日から 1〜2 日程度でのお届けとなります。
━━━━━━━━━━━━━━━━━━`
).trim();

        const to = { email: H.email, name: H.customer_name || H.email };
        const params = {
  customer_name: to.name || "お客様",
  support_email: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM,
  order_detail_block_text: buildOrderDetailBlockFromRows(rowsQ.rows),
  tracking_block_text: tracking_block
};

        const mid = await sendBrevoTemplate(process.env.BREVO_TEMPLATE_SHIPPED, to, params);
        await finishEmailOk(pool, eventId, mid);
        ok++;
      } catch (e) {
        await finishEmailFail(pool, token, 'shipped_notice', e);
        errors.push({ token, reason: String(e) });
      }
    }
    res.json({ ok, ng_count: errors.length, errors });
  } catch (e) { console.error(e); res.status(500).json({ error: "server error" }); }
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
    
        // ★ 支払い済みに変更された場合は、入金完了メールを送信
    if (paid) {
      try {
        // 予約（冪等化・二重送信防止）
        const eventId = await reserveEmail(pool, token, 'paid_notice', 'admin');
        // 既にある場合は eventId が null（＝送信済み or 送信予約済み）
        if (eventId && process.env.BREVO_TEMPLATE_PAID) {
          const headQ = await pool.query("SELECT * FROM v_order_quick WHERE order_token=$1", [token]);
          const rowsQ = await pool.query("SELECT * FROM orders_all    WHERE order_token=$1 ORDER BY id", [token]);
          if (headQ.rowCount) {
            const H = headQ.rows[0];
            const to = { email: H.email, name: H.customer_name || H.email };
            const params = {
              customer_name: to.name || "お客様",
              support_email: process.env.SUPPORT_EMAIL || process.env.MAIL_FROM,
              order_detail_block_text: buildOrderDetailBlockFromRows(rowsQ.rows)
            };
            const mid = await sendBrevoTemplate(process.env.BREVO_TEMPLATE_PAID, to, params);
            await finishEmailOk(pool, eventId, mid);
          } else {
            // 予約は立ったがヘッダが無い場合は失敗記録
            await finishEmailFail(pool, token, 'paid_notice', 'order header not found');
          }
        }
      } catch (e) {
        await finishEmailFail(pool, token, 'paid_notice', e);
        console.error("admin paid_notice send error:", e);
        // 送信失敗しても API 自体は 200 を返す（UI操作は成功）
      }
    }
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

// ===== 管理：テスト送信（Brevo ダイレクト） =====
app.post("/api/admin/test-email", adminAuth, async (req, res) => {
  try {
    const { to, subject = "Test from nursery sera", text = "Hello", html } = req.body || {};
    if (!to) return res.status(400).json({ error: "missing 'to' address" });
    if (!process.env.BREVO_API_KEY) return res.status(500).json({ error: "BREVO_API_KEY not set" });
    if (!process.env.MAIL_FROM)     return res.status(500).json({ error: "MAIL_FROM not set" });

    const payload = {
      sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_NAME || "nursery sera" },
      to: [{ email: to }],
      subject,
      textContent: text,
      ...(html ? { htmlContent: html } : {})
    };

    const resp = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: {
        "api-key": process.env.BREVO_API_KEY,
        "Content-Type": "application/json",
        "accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const bodyText = await resp.text();
    let bodyJson; try { bodyJson = bodyText ? JSON.parse(bodyText) : null; } catch { bodyJson = { raw: bodyText }; }

    return res.status(resp.status).json({ ok: resp.ok, status: resp.status, body: bodyJson });
  } catch (e) {
    console.error("admin/test-email error", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
});