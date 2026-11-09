// Capa de base de datos: Postgres (Neon en Vercel) o PGlite local para desarrollo y pruebas.
// API: await db.get(sql, ...params) · db.all(...) · db.run(...) · db.insert(...) → id · db.tx(async (q) => ...)
// Los "?" del SQL se convierten a $1, $2… automáticamente.
const config = require('./config');

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}
function fixRow(row) {
  if (!row) return row;
  for (const k in row) if (typeof row[k] === 'bigint') row[k] = Number(row[k]);
  return row;
}

let driver; // { query(sql, params) → rows, tx(fn) }
async function makeDriver() {
  if (config.DATABASE_URL) {
    const pg = require('pg');
    pg.types.setTypeParser(20, (v) => Number(v)); // bigint (COUNT, SUM)
    pg.types.setTypeParser(1700, (v) => Number(v)); // numeric
    const pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 3),
      ssl: /localhost|127\.0\.0\.1/.test(config.DATABASE_URL) ? false : { rejectUnauthorized: false },
    });
    return {
      query: async (sql, params) => (await pool.query(sql, params)).rows,
      tx: async (fn) => {
        const c = await pool.connect();
        try {
          await c.query('BEGIN');
          const out = await fn({ query: async (s, p) => (await c.query(s, p)).rows });
          await c.query('COMMIT');
          return out;
        } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
      },
      exec: (sql) => pool.query(sql),
    };
  }
  if (process.env.VERCEL) throw new Error('Falta DATABASE_URL: conectá la base Neon al proyecto en Vercel (Storage) y volvé a publicar.');
  // Desarrollo local / pruebas: Postgres embebido (PGlite) guardado en DATA_DIR
  const { PGlite } = require('@electric-sql/pglite');
  const fs = require('fs');
  const path = require('path');
  let pgl;
  if (process.env.PGLITE_MEMORY === '1') pgl = new PGlite();
  else { fs.mkdirSync(config.DATA_DIR, { recursive: true }); pgl = new PGlite(path.join(config.DATA_DIR, 'pgdata')); }
  return {
    query: async (sql, params) => (await pgl.query(sql, params)).rows,
    tx: (fn) => pgl.transaction((t) => fn({ query: async (s, p) => (await t.query(s, p)).rows })),
    exec: (sql) => pgl.exec(sql),
  };
}

const NOW = "to_char(now() at time zone 'utc', 'YYYY-MM-DD HH24:MI:SS')";

const SCHEMA = `
CREATE OR REPLACE FUNCTION norm(t text) RETURNS text AS $$
  SELECT translate(lower(coalesce(t, '')), 'áàäâãéèëêíìïîóòöôõúùüûñç', 'aaaaaeeeeiiiiooooouuuunc')
$$ LANGUAGE sql IMMUTABLE;

CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'merchant',
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS categories (
  id SERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT '🏪',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS businesses (
  id SERIAL PRIMARY KEY,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  zone TEXT NOT NULL DEFAULT '',
  directions TEXT NOT NULL DEFAULT '',
  maps_url TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  instagram TEXT NOT NULL DEFAULT '',
  facebook TEXT NOT NULL DEFAULT '',
  hours_json TEXT NOT NULL DEFAULT '{}',
  logo TEXT NOT NULL DEFAULT '',
  cover TEXT NOT NULL DEFAULT '',
  gallery_json TEXT NOT NULL DEFAULT '[]',
  delivery TEXT NOT NULL DEFAULT 'retiro',
  plan TEXT NOT NULL DEFAULT 'basico',
  plan_until TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  admin_note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS products (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price INTEGER,
  price_note TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'disponible',
  photo TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT ${NOW},
  updated_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_products_biz ON products(business_id);
CREATE TABLE IF NOT EXISTS promotions (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  conditions TEXT NOT NULL DEFAULT '',
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS redemptions (
  id SERIAL PRIMARY KEY,
  promotion_id INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS requests (
  id SERIAL PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id),
  description TEXT NOT NULL,
  budget INTEGER,
  zone TEXT NOT NULL DEFAULT '',
  deadline TEXT NOT NULL DEFAULT '',
  photo TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS proposals (
  id SERIAL PRIMARY KEY,
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  price INTEGER,
  message TEXT NOT NULL DEFAULT '',
  availability TEXT NOT NULL DEFAULT 'disponible',
  delivery TEXT NOT NULL DEFAULT 'retiro',
  photo TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW},
  UNIQUE(request_id, business_id)
);
CREATE TABLE IF NOT EXISTS request_dismissals (
  request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  PRIMARY KEY (request_id, business_id)
);
CREATE TABLE IF NOT EXISTS events (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  product_id INTEGER,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE INDEX IF NOT EXISTS idx_events_biz ON events(business_id, type, created_at);
CREATE TABLE IF NOT EXISTS reports (
  id SERIAL PRIMARY KEY,
  business_id INTEGER REFERENCES businesses(id) ON DELETE CASCADE,
  product_id INTEGER,
  request_id INTEGER,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  months INTEGER NOT NULL DEFAULT 1,
  amount INTEGER NOT NULL DEFAULT 0,
  method TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (sid TEXT PRIMARY KEY, sess TEXT NOT NULL, expires BIGINT NOT NULL);
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  business TEXT NOT NULL DEFAULT '',
  whatsapp TEXT NOT NULL DEFAULT '',
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT ${NOW}
);
`;

const DEFAULT_CATEGORIES = [
  ['gastronomia', 'Gastronomía', '🍽️'], ['cafeterias', 'Cafeterías y panaderías', '☕'], ['ropa', 'Ropa y accesorios', '👕'],
  ['calzado', 'Calzado', '👟'], ['belleza', 'Peluquería y belleza', '💇'], ['almacen', 'Almacén y supermercado', '🛒'],
  ['hogar', 'Hogar y deco', '🛋️'], ['ferreteria', 'Ferretería y construcción', '🔧'], ['tecnologia', 'Tecnología y celulares', '📱'],
  ['salud', 'Farmacia y salud', '💊'], ['mascotas', 'Mascotas', '🐾'], ['ninos', 'Niños y jugueterías', '🧸'],
  ['deportes', 'Deportes', '⚽'], ['libreria', 'Librería y regalos', '📚'], ['servicios', 'Servicios y oficios', '🛠️'],
  ['turismo', 'Turismo y alojamiento', '🏨'], ['otros', 'Otros rubros', '🏪'],
];
const DEFAULT_SETTINGS = {
  price_pro: '4000', price_destacado: '12000', trial_days: '30', basic_product_limit: '10', pro_product_limit: '200',
  request_days: '7', requests_per_day: '3', contact_whatsapp: '', contact_email: '', instagram: '',
  payment_instructions: 'Transferencia bancaria o Mercado Pago.\nAlias: COMPLETAR.ALIAS\nTitular: COMPLETAR\nEnviá el comprobante por WhatsApp y activamos tu plan en el día.',
};

let readyPromise;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      driver = await makeDriver();
      await driver.exec(SCHEMA);
      const cats = await driver.query('SELECT COUNT(*)::int AS n FROM categories');
      if (!cats[0].n) {
        for (let i = 0; i < DEFAULT_CATEGORIES.length; i++) {
          const [slug, name, icon] = DEFAULT_CATEGORIES[i];
          await driver.query('INSERT INTO categories (slug, name, icon, sort) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [slug, name, icon, i]);
        }
      }
      for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        await driver.query('INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT DO NOTHING', [k, v]);
      }
    })().catch((e) => { readyPromise = null; throw e; });
  }
  return readyPromise;
}

function wrap(q) {
  return {
    all: async (sql, ...p) => (await q(toPg(sql), p)).map(fixRow),
    get: async (sql, ...p) => fixRow((await q(toPg(sql), p))[0]),
    run: async (sql, ...p) => { await q(toPg(sql), p); },
    insert: async (sql, ...p) => fixRow((await q(toPg(sql) + ' RETURNING id', p))[0]).id,
  };
}
const db = {
  ...wrap(async (s, p) => { await ready(); return driver.query(s, p); }),
  tx: async (fn) => { await ready(); return driver.tx((t) => fn(wrap(t.query))); },
  ready,
};

async function getSettings() {
  const out = {};
  for (const r of await db.all('SELECT key, value FROM settings')) out[r.key] = r.value;
  return out;
}
async function setSetting(key, value) {
  await db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, String(value));
}

module.exports = { db, norm, getSettings, setSetting, NOW };
