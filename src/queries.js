const { db, norm } = require('./db');
const lib = require('./lib');

const BIZ_COLS = `b.id, b.slug, b.name, b.description, b.zone, b.address, b.logo, b.cover, b.hours_json, b.updated_at,
  b.plan, b.plan_until, b.whatsapp, b.delivery, c.name AS category_name, c.icon AS category_icon, c.slug AS category_slug`;

function decorateBiz(b) {
  if (!b) return b;
  b.open = lib.isOpenNow(b.hours_json);
  b.hasHours = lib.hasHours(b.hours_json);
  b.effPlan = lib.effectivePlan(b);
  return b;
}

function tokensWhere(q, expr, params) {
  const toks = norm(q).split(/\s+/).filter((t) => t.length > 1).slice(0, 6);
  return toks.map((t) => { params.push(`%${t}%`); return `norm(${expr}) LIKE ?`; });
}

async function searchBusinesses({ q, cat, zona, limit = 60, offset = 0 } = {}) {
  const where = ["b.status = 'approved'"], params = [];
  if (q) where.push(...tokensWhere(q, "b.name || ' ' || b.description || ' ' || COALESCE(c.name,'') || ' ' || b.zone", params));
  if (cat) { where.push('c.slug = ?'); params.push(cat); }
  if (zona) { where.push('norm(b.zone) = ?'); params.push(norm(zona)); }
  const rows = await db.all(`SELECT ${BIZ_COLS},
      (SELECT COUNT(*)::int FROM products p WHERE p.business_id = b.id AND p.active = 1) AS product_count
    FROM businesses b LEFT JOIN categories c ON c.id = b.category_id
    WHERE ${where.join(' AND ')}
    ORDER BY b.updated_at DESC LIMIT ? OFFSET ?`, ...params, limit, offset);
  return rows.map(decorateBiz);
}

const PROD_COLS = `p.id, p.name, p.description, p.price, p.price_note, p.availability, p.photo, p.updated_at,
  b.id AS business_id, b.slug AS business_slug, b.name AS business_name, b.zone, b.hours_json, b.whatsapp, b.plan, b.plan_until,
  c.name AS category_name, c.slug AS category_slug`;

async function searchProducts({ q, cat, zona, min, max, sort, businessId, limit = 60, offset = 0 } = {}) {
  const where = ["b.status = 'approved'", 'p.active = 1'], params = [];
  if (q) where.push(...tokensWhere(q, "p.name || ' ' || p.description || ' ' || b.name || ' ' || COALESCE(c.name,'')", params));
  if (cat) { where.push('c.slug = ?'); params.push(cat); }
  if (zona) { where.push('norm(b.zone) = ?'); params.push(norm(zona)); }
  if (min) { where.push('p.price >= ?'); params.push(min); }
  if (max) { where.push('p.price <= ?'); params.push(max); }
  if (businessId) { where.push('b.id = ?'); params.push(businessId); }
  const order = sort === 'precio_asc' ? 'p.price IS NULL, p.price ASC'
    : sort === 'precio_desc' ? 'p.price IS NULL, p.price DESC'
      : "CASE p.availability WHEN 'sin_stock' THEN 1 ELSE 0 END, p.updated_at DESC, p.id DESC";
  const rows = await db.all(`SELECT ${PROD_COLS}
    FROM products p JOIN businesses b ON b.id = p.business_id LEFT JOIN categories c ON c.id = b.category_id
    WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ? OFFSET ?`, ...params, limit, offset);
  return rows.map((p) => { p.open = lib.isOpenNow(p.hours_json); return p; });
}

async function activePromotions({ businessId, limit = 40 } = {}) {
  const today = lib.todayAR();
  const params = [today, today];
  let extra = '';
  if (businessId) { extra = ' AND b.id = ?'; params.push(businessId); }
  const rows = await db.all(`SELECT pr.*, b.slug AS business_slug, b.name AS business_name, b.zone, b.whatsapp, b.plan, b.plan_until,
      c.icon AS category_icon, c.name AS category_name
    FROM promotions pr JOIN businesses b ON b.id = pr.business_id LEFT JOIN categories c ON c.id = b.category_id
    WHERE b.status = 'approved' AND pr.starts_at <= ? AND pr.ends_at >= ? ${extra}
    ORDER BY pr.ends_at ASC LIMIT ?`, ...params, limit);
  return rows.filter((p) => lib.effectivePlan(p) !== 'basico');
}

async function sponsored({ cat, zona, limit = 3 } = {}) {
  const list = (await searchBusinesses({ cat, zona, limit: 200 })).filter((b) => b.effPlan === 'destacado');
  for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  return list.slice(0, limit);
}

async function zones() {
  return (await db.all("SELECT MIN(zone) AS zone, COUNT(*) n FROM businesses WHERE status = 'approved' AND zone != '' GROUP BY norm(zone) ORDER BY n DESC")).map((r) => r.zone);
}

// Comercios que reciben una solicitud BUSCO YA: rubro coincidente, aprobados y con plan pago vigente.
async function matchingBusinessesForRequest(reqRow) {
  return (await db.all("SELECT * FROM businesses WHERE status = 'approved' AND category_id = ?", reqRow.category_id))
    .filter((b) => lib.effectivePlan(b) !== 'basico');
}

module.exports = { decorateBiz, searchBusinesses, searchProducts, activePromotions, sponsored, zones, matchingBusinessesForRequest, BIZ_COLS };
