const express = require('express');
const cors = require('cors');
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Return numbers as numbers (pg sends NUMERIC and COUNT as strings by default)
types.setTypeParser(1700, parseFloat);
types.setTypeParser(20, v => parseInt(v, 10));

const SECRET = process.env.JWT_SECRET || 'change-this-secret';
const url = process.env.DATABASE_URL;
if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
const local = /localhost|127\.0\.0\.1/.test(url);
const pool = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false } });

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY, username TEXT UNIQUE, hash TEXT);
    CREATE TABLE IF NOT EXISTS products(id SERIAL PRIMARY KEY, name TEXT, category TEXT, price NUMERIC, stock INTEGER, reorder_at INTEGER);
    CREATE TABLE IF NOT EXISTS orders(id SERIAL PRIMARY KEY, customer TEXT, product_id INTEGER REFERENCES products(id), qty INTEGER, total NUMERIC, placed TIMESTAMPTZ DEFAULT now());
  `);

  const users = await pool.query('SELECT COUNT(*) c FROM users');
  if (!users.rows[0].c) {
    await pool.query('INSERT INTO users(username,hash) VALUES($1,$2)',
      ['admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'stockpulse123', 10)]);
  }

  const prods = await pool.query('SELECT COUNT(*) c FROM products');
  if (!prods.rows[0].c) {
    const items = [
      ['Wireless Mouse', 'Accessories', 8500, 42, 15], ['USB-C Hub', 'Accessories', 15500, 9, 12],
      ['Laptop Stand', 'Accessories', 12000, 27, 10], ['Mechanical Keyboard', 'Accessories', 32000, 6, 8],
      ['27" Monitor', 'Displays', 185000, 11, 5], ['Webcam HD', 'Displays', 24000, 4, 8],
      ['Power Bank 20k', 'Power', 19500, 38, 15], ['Extension Socket', 'Power', 7500, 60, 20],
      ['Inverter 1.5kVA', 'Power', 265000, 3, 4], ['Router 4G', 'Network', 45000, 14, 6],
      ['Ethernet Cable 10m', 'Network', 3500, 90, 30], ['Bluetooth Speaker', 'Audio', 21000, 7, 10],
    ];
    const ids = [];
    for (const i of items) {
      const r = await pool.query(
        'INSERT INTO products(name,category,price,stock,reorder_at) VALUES($1,$2,$3,$4,$5) RETURNING id, price', i);
      ids.push(r.rows[0]);
    }
    const names = ['Ade Stores', 'Chioma Tech', 'Bola Gadgets', 'Kunle & Sons', 'Ngozi Mart', 'Tunde Hub', 'Amaka Supplies'];
    for (let n = 0; n < 60; n++) {
      const p = ids[Math.floor(Math.random() * ids.length)];
      const qty = 1 + Math.floor(Math.random() * 4);
      const day = new Date(Date.now() - Math.floor(Math.random() * 30) * 864e5).toISOString();
      await pool.query('INSERT INTO orders(customer,product_id,qty,total,placed) VALUES($1,$2,$3,$4,$5)',
        [names[Math.floor(Math.random() * names.length)], p.id, qty, p.price * qty, day]);
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json());

const wrap = fn => (req, res) => fn(req, res).catch(e => {
  console.error(e); res.status(500).json({ error: 'Server error, please try again' });
});

const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in again' }); }
};

app.get('/', (_, res) => res.json({ ok: true, service: 'stockpulse-api', db: 'postgres' }));

app.post('/api/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const r = await pool.query('SELECT * FROM users WHERE username=$1', [username || '']);
  const u = r.rows[0];
  if (!u || !bcrypt.compareSync(password || '', u.hash))
    return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ token: jwt.sign({ id: u.id, username: u.username }, SECRET, { expiresIn: '12h' }) });
}));

app.get('/api/summary', auth, wrap(async (_, res) => {
  const p = await pool.query(`SELECT COUNT(*)::int skus, COALESCE(SUM(price*stock),0) value,
    COALESCE(SUM((stock<=reorder_at)::int),0)::int low FROM products`);
  const o = await pool.query(`SELECT COUNT(*)::int orders, COALESCE(SUM(total),0) revenue
    FROM orders WHERE placed >= now() - interval '30 days'`);
  const d = await pool.query(`SELECT to_char(placed,'YYYY-MM-DD') d, SUM(total) total
    FROM orders GROUP BY 1 ORDER BY 1 DESC LIMIT 14`);
  res.json({ ...p.rows[0], ...o.rows[0], daily: d.rows.reverse() });
}));

app.get('/api/products', auth, wrap(async (_, res) => {
  const r = await pool.query('SELECT * FROM products ORDER BY stock::float / reorder_at ASC');
  res.json(r.rows);
}));

app.get('/api/orders', auth, wrap(async (_, res) => {
  const r = await pool.query(`SELECT o.id, o.customer, o.qty, o.total, o.placed, p.name product
    FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.placed DESC LIMIT 15`);
  res.json(r.rows);
}));

app.post('/api/products/:id/restock', auth, wrap(async (req, res) => {
  const qty = Number(req.body && req.body.qty);
  const id = Number(req.params.id);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000)
    return res.status(400).json({ error: 'Enter a whole number from 1 to 10,000' });
  if (!Number.isInteger(id)) return res.status(404).json({ error: 'Product not found' });
  const r = await pool.query('UPDATE products SET stock=stock+$1 WHERE id=$2 RETURNING *', [qty, id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Product not found' });
  res.json(r.rows[0]);
}));

app.post('/api/products', auth, wrap(async (req, res) => {
  const { name, category, price, stock, reorder_at } = req.body || {};
  const p = Number(price), s = Number(stock), r = Number(reorder_at);
  if (!String(name || '').trim() || !String(category || '').trim() || !(p > 0) ||
      !Number.isInteger(s) || s < 0 || !Number.isInteger(r) || r < 1)
    return res.status(400).json({ error: 'Fill in name, category, a price above 0, stock and a reorder level' });
  const out = await pool.query(
    'INSERT INTO products(name,category,price,stock,reorder_at) VALUES($1,$2,$3,$4,$5) RETURNING *',
    [String(name).trim().slice(0, 80), String(category).trim().slice(0, 40), p, s, r]);
  res.status(201).json(out.rows[0]);
}));

app.post('/api/orders', auth, wrap(async (req, res) => {
  const { customer, product_id, qty } = req.body || {};
  const pid = Number(product_id), q = Number(qty);
  if (!String(customer || '').trim() || !Number.isInteger(pid) || !Number.isInteger(q) || q < 1 || q > 10000)
    return res.status(400).json({ error: 'Enter a customer, a product and a whole-number quantity' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pr = await client.query('SELECT price, stock FROM products WHERE id=$1 FOR UPDATE', [pid]);
    if (!pr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Product not found' }); }
    if (pr.rows[0].stock < q) { await client.query('ROLLBACK'); return res.status(400).json({ error: `Only ${pr.rows[0].stock} in stock` }); }
    await client.query('UPDATE products SET stock=stock-$1 WHERE id=$2', [q, pid]);
    const o = await client.query('INSERT INTO orders(customer,product_id,qty,total) VALUES($1,$2,$3,$4) RETURNING *',
      [String(customer).trim().slice(0, 80), pid, q, pr.rows[0].price * q]);
    await client.query('COMMIT');
    res.status(201).json(o.rows[0]);
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}));

init()
  .then(() => app.listen(process.env.PORT || 3000, () => console.log('StockPulse API running')))
  .catch(e => { console.error('Startup failed:', e.message); process.exit(1); });
