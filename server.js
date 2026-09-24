const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET || 'change-this-secret';
const db = new Database(process.env.DB_PATH || 'stockpulse.db');

db.exec(`
CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY, username TEXT UNIQUE, hash TEXT);
CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY, name TEXT, category TEXT, price REAL, stock INTEGER, reorder_at INTEGER);
CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY, customer TEXT, product_id INTEGER, qty INTEGER, total REAL, placed TEXT);
`);

// ---- Seed data (runs once) ----
if (!db.prepare('SELECT COUNT(*) c FROM users').get().c) {
  db.prepare('INSERT INTO users(username,hash) VALUES(?,?)')
    .run('admin', bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'stockpulse123', 10));
}
if (!db.prepare('SELECT COUNT(*) c FROM products').get().c) {
  const items = [
    ['Wireless Mouse', 'Accessories', 8500, 42, 15], ['USB-C Hub', 'Accessories', 15500, 9, 12],
    ['Laptop Stand', 'Accessories', 12000, 27, 10], ['Mechanical Keyboard', 'Accessories', 32000, 6, 8],
    ['27" Monitor', 'Displays', 185000, 11, 5], ['Webcam HD', 'Displays', 24000, 4, 8],
    ['Power Bank 20k', 'Power', 19500, 38, 15], ['Extension Socket', 'Power', 7500, 60, 20],
    ['Inverter 1.5kVA', 'Power', 265000, 3, 4], ['Router 4G', 'Network', 45000, 14, 6],
    ['Ethernet Cable 10m', 'Network', 3500, 90, 30], ['Bluetooth Speaker', 'Audio', 21000, 7, 10],
  ];
  const ins = db.prepare('INSERT INTO products(name,category,price,stock,reorder_at) VALUES(?,?,?,?,?)');
  items.forEach(i => ins.run(...i));

  const names = ['Ade Stores', 'Chioma Tech', 'Bola Gadgets', 'Kunle & Sons', 'Ngozi Mart', 'Tunde Hub', 'Amaka Supplies'];
  const ord = db.prepare('INSERT INTO orders(customer,product_id,qty,total,placed) VALUES(?,?,?,?,?)');
  const prods = db.prepare('SELECT id, price FROM products').all();
  for (let i = 0; i < 60; i++) {
    const p = prods[Math.floor(Math.random() * prods.length)];
    const qty = 1 + Math.floor(Math.random() * 4);
    const day = new Date(Date.now() - Math.floor(Math.random() * 30) * 864e5).toISOString();
    ord.run(names[Math.floor(Math.random() * names.length)], p.id, qty, p.price * qty, day);
  }
}

// ---- App ----
const app = express();
app.use(cors());
app.use(express.json());

const auth = (req, res, next) => {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  try { req.user = jwt.verify(t, SECRET); next(); }
  catch { res.status(401).json({ error: 'Please sign in again' }); }
};

app.get('/', (_, res) => res.json({ ok: true, service: 'stockpulse-api' }));

app.post('/api/login', (req, res) => {
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username || '');
  if (!u || !bcrypt.compareSync(password || '', u.hash))
    return res.status(401).json({ error: 'Wrong username or password' });
  res.json({ token: jwt.sign({ id: u.id, username: u.username }, SECRET, { expiresIn: '12h' }) });
});

app.get('/api/summary', auth, (_, res) => {
  const p = db.prepare('SELECT COUNT(*) skus, SUM(price*stock) value, SUM(stock<=reorder_at) low FROM products').get();
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const o = db.prepare('SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue FROM orders WHERE placed>=?').get(since);
  const daily = db.prepare(`SELECT substr(placed,1,10) d, SUM(total) total FROM orders
    GROUP BY d ORDER BY d DESC LIMIT 14`).all().reverse();
  res.json({ ...p, ...o, daily });
});

app.get('/api/products', auth, (_, res) =>
  res.json(db.prepare('SELECT * FROM products ORDER BY (stock*1.0/reorder_at) ASC').all()));

app.get('/api/orders', auth, (_, res) =>
  res.json(db.prepare(`SELECT o.id, o.customer, o.qty, o.total, o.placed, p.name product
    FROM orders o JOIN products p ON p.id=o.product_id ORDER BY o.placed DESC LIMIT 15`).all()));

app.post('/api/products/:id/restock', auth, (req, res) => {
  const qty = Number(req.body && req.body.qty);
  if (!Number.isInteger(qty) || qty < 1 || qty > 10000)
    return res.status(400).json({ error: 'Enter a whole number from 1 to 10,000' });
  const r = db.prepare('UPDATE products SET stock=stock+? WHERE id=?').run(qty, req.params.id);
  if (!r.changes) return res.status(404).json({ error: 'Product not found' });
  res.json(db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id));
});

app.listen(process.env.PORT || 3000, () => console.log('StockPulse API running'));
