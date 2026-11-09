const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const session = require('express-session');
const { db } = require('./db');
const config = require('./config');

// ---------- Fechas (hora de Argentina) ----------
const DAYS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

function nowAR() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date());
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  const hour = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${hour}:${p.minute}`, weekday: wd };
}
function todayAR() { return nowAR().date; }

// SQLite guarda UTC "YYYY-MM-DD HH:MM:SS"
function sqlNow() { return new Date().toISOString().slice(0, 19).replace('T', ' '); }
function sqlDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}
function sqlPlusDays(days, from) {
  const base = from ? new Date(String(from).replace(' ', 'T') + 'Z') : new Date();
  const start = base > new Date() ? base : new Date();
  return new Date(start.getTime() + days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
}

function fmtDate(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(String(sqlDate).replace(' ', 'T') + (String(sqlDate).length > 10 ? 'Z' : 'T12:00:00Z'));
  return d.toLocaleDateString('es-AR', { timeZone: config.TZ, day: 'numeric', month: 'short', year: 'numeric' });
}
function fmtDateTime(sqlDate) {
  if (!sqlDate) return '';
  const d = new Date(String(sqlDate).replace(' ', 'T') + 'Z');
  return d.toLocaleString('es-AR', { timeZone: config.TZ, day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function timeAgo(sqlDate) {
  if (!sqlDate) return '';
  const diff = (Date.now() - new Date(String(sqlDate).replace(' ', 'T') + 'Z').getTime()) / 1000;
  if (diff < 60) return 'recién';
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  const d = Math.floor(diff / 86400);
  if (d === 1) return 'ayer';
  if (d < 30) return `hace ${d} días`;
  return fmtDate(sqlDate);
}

function fmtPrice(n) {
  if (n === null || n === undefined || n === '') return '';
  return '$' + Number(n).toLocaleString('es-AR', { maximumFractionDigits: 0 });
}

// ---------- Horarios ----------
// hours: { "1": [["09:00","13:00"],["17:00","20:30"]], ... } (0 = domingo)
function parseHours(json) {
  try { return JSON.parse(json || '{}') || {}; } catch { return {}; }
}
function toMin(t) { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); }
function isOpenNow(hoursJson) {
  const hours = parseHours(hoursJson);
  const { weekday, time } = nowAR();
  const t = toMin(time);
  const today = hours[weekday] || [];
  for (const [a, b] of today) {
    if (!a || !b) continue;
    const s = toMin(a), e = toMin(b);
    if (e > s ? t >= s && t < e : t >= s) return true; // cierre después de medianoche
  }
  const yest = hours[(weekday + 6) % 7] || [];
  for (const [a, b] of yest) {
    if (!a || !b) continue;
    if (toMin(b) <= toMin(a) && t < toMin(b)) return true;
  }
  return false;
}
function hasHours(hoursJson) {
  return Object.values(parseHours(hoursJson)).some((r) => r && r.length);
}
function hoursRows(hoursJson) {
  const hours = parseHours(hoursJson);
  const { weekday } = nowAR();
  return DAY_ORDER.map((d) => ({
    day: DAYS[d], today: d === weekday,
    text: (hours[d] || []).filter((r) => r[0] && r[1]).map((r) => `${r[0]} a ${r[1]}`).join(' y ') || 'Cerrado',
  }));
}

// ---------- Planes ----------
function effectivePlan(biz) {
  if (!biz) return 'basico';
  if (biz.plan === 'basico') return 'basico';
  if (!biz.plan_until) return 'basico';
  return biz.plan_until > sqlNow() ? biz.plan : 'basico';
}
function planLimits(plan, s) {
  return {
    products: plan === 'basico' ? Number(s.basic_product_limit) : Number(s.pro_product_limit),
    promos: plan !== 'basico',
    buscoYa: plan !== 'basico',
    metrics: plan !== 'basico',
    sponsored: plan === 'destacado',
  };
}
const PLAN_NAMES = { basico: 'Básico', pro: 'Comercio Pro', destacado: 'Destacado' };

// ---------- Texto ----------
function slugify(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'comercio';
}
async function uniqueSlug(name, excludeId) {
  const base = slugify(name);
  let slug = base, i = 2;
  while (await db.get('SELECT id FROM businesses WHERE slug = ? AND id != ?', slug, excludeId || 0)) slug = `${base}-${i++}`;
  return slug;
}
// Normaliza a formato wa.me (Argentina: 549 + área + número)
function normPhone(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('54')) {
    d = d.slice(2);
    if (d.startsWith('9')) d = d.slice(1);
  }
  if (d.startsWith('0')) d = d.slice(1);
  // quita el "15" de celulares escritos como 2323 15 123456
  const m = d.match(/^(\d{2,4})15(\d{6,8})$/);
  if (m && (m[1] + m[2]).length === 10) d = m[1] + m[2];
  // número local de Luján sin código de área (6 dígitos): se agrega 2323
  if (d.length === 6) d = '2323' + d;
  return '549' + d;
}
function waLink(phone, text) {
  const n = normPhone(phone);
  if (!n) return '';
  return `https://wa.me/${n}${text ? '?text=' + encodeURIComponent(text) : ''}`;
}
function safeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { const x = new URL(u); return ['http:', 'https:'].includes(x.protocol) ? x.href : ''; } catch { return ''; }
}
function igUrl(v) {
  v = String(v || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v) || v.includes('instagram.com')) return safeUrl(v);
  return 'https://instagram.com/' + v.replace(/^@/, '');
}
function mapsLink(biz) {
  if (biz.maps_url) return safeUrl(biz.maps_url);
  if (!biz.address) return '';
  return 'https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(`${biz.address}, Luján, Buenos Aires`);
}
function mapsEmbed(biz) {
  if (!biz.address) return '';
  return 'https://www.google.com/maps?output=embed&q=' + encodeURIComponent(`${biz.address}, Luján, Buenos Aires`);
}
function toInt(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[^\d]/g, '');
  return s ? Math.min(Number(s), 2_000_000_000) : null;
}
function clip(s, n) { return String(s || '').trim().slice(0, n); }
function token(n = 16) { return crypto.randomBytes(n).toString('base64url'); }

// ---------- Imágenes ----------
// Las fotos se optimizan a WebP en dos tamaños (grande -o y miniatura -t) y se guardan en
// Cloudflare R2 / cualquier S3 (producción) o en DATA_DIR/uploads (desarrollo local).
let s3;
function s3Client() {
  if (!s3) {
    const { S3Client } = require('@aws-sdk/client-s3');
    s3 = new S3Client({
      region: process.env.S3_REGION || 'auto',
      endpoint: config.S3.endpoint,
      credentials: { accessKeyId: config.S3.key, secretAccessKey: config.S3.secret },
    });
  }
  return s3;
}
async function storeFile(name, buf) {
  if (config.S3.bucket) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await s3Client().send(new PutObjectCommand({
      Bucket: config.S3.bucket, Key: `uploads/${name}`, Body: buf, ContentType: 'image/webp',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    return `${config.S3.publicUrl}/uploads/${name}`;
  }
  fs.mkdirSync(config.UPLOAD_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(config.UPLOAD_DIR, name), buf);
  return '/uploads/' + name;
}
async function saveImage(file, { width = 1200, height = 1200, fit = 'inside', thumb = 480 } = {}) {
  if (!file) return '';
  const base = `${Date.now().toString(36)}-${token(6)}`;
  const img = sharp(file.buffer, { failOn: 'none' }).rotate();
  const big = await img.clone().resize({ width, height, fit, withoutEnlargement: true }).webp({ quality: 78 }).toBuffer();
  const url = await storeFile(`${base}-o.webp`, big);
  if (thumb) {
    const small = await img.clone().resize({ width: thumb, height: thumb, fit: fit === 'cover' ? 'cover' : 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
    await storeFile(`${base}-t.webp`, small);
  }
  return url;
}
// Miniatura de una foto (si existe); para fotos viejas sin miniatura devuelve la original.
function thumb(url) { return url && /-o\.webp$/.test(url) ? url.replace(/-o\.webp$/, '-t.webp') : url; }
function deleteImage(url) {
  if (!url) return;
  const files = /-o\.webp$/.test(url) ? [url, thumb(url)] : [url];
  for (const u of files) {
    if (u.startsWith('/uploads/')) fs.promises.unlink(path.join(config.UPLOAD_DIR, path.basename(u))).catch(() => {});
    else if (config.S3.bucket && config.S3.publicUrl && u.startsWith(config.S3.publicUrl + '/')) {
      const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
      s3Client().send(new DeleteObjectCommand({ Bucket: config.S3.bucket, Key: u.slice(config.S3.publicUrl.length + 1) })).catch(() => {});
    }
  }
}
function absUrl(base, u) { return !u ? '' : /^https?:/.test(u) ? u : base + u; }

// ---------- Métricas ----------
async function track(businessId, type, productId) {
  if (!businessId) return;
  try { await db.run('INSERT INTO events (business_id, product_id, type) VALUES (?, ?, ?)', businessId, productId || null, type); } catch (e) { console.error(e); }
}

// ---------- Sesiones en la base de datos ----------
class DbStore extends session.Store {
  get(sid, cb) {
    db.get('SELECT sess FROM sessions WHERE sid = ? AND expires > ?', sid, Date.now())
      .then((r) => cb(null, r ? JSON.parse(r.sess) : null), cb);
  }
  set(sid, sess, cb) {
    const exp = sess.cookie && sess.cookie.expires ? new Date(sess.cookie.expires).getTime() : Date.now() + 86400000;
    db.run('INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?) ON CONFLICT (sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires', sid, JSON.stringify(sess), exp)
      .then(() => {
        if (Math.random() < 0.01) db.run('DELETE FROM sessions WHERE expires < ?', Date.now()).catch(() => {});
        cb && cb(null);
      }, (e) => cb && cb(e));
  }
  destroy(sid, cb) { db.run('DELETE FROM sessions WHERE sid = ?', sid).then(() => cb && cb(null), (e) => cb && cb(e)); }
  touch(sid, sess, cb) { this.set(sid, sess, cb); }
}

// ---------- Rate limit simple en memoria ----------
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const b = buckets.get(key) || [];
  const recent = b.filter((t) => now - t < windowMs);
  if (recent.length >= max) { buckets.set(key, recent); return false; }
  recent.push(now); buckets.set(key, recent);
  return true;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.some((t) => now - t < 3600_000)) buckets.delete(k); }, 600_000).unref();

module.exports = {
  DAYS, DAY_ORDER, nowAR, todayAR, sqlNow, sqlPlusDays, sqlDaysAgo, absUrl, fmtDate, fmtDateTime, timeAgo, fmtPrice,
  parseHours, isOpenNow, hasHours, hoursRows, effectivePlan, planLimits, PLAN_NAMES,
  slugify, uniqueSlug, normPhone, waLink, safeUrl, igUrl, mapsLink, mapsEmbed, toInt, clip, token,
  saveImage, deleteImage, thumb, track, DbStore, rateLimit,
};
