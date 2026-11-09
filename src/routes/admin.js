const express = require('express');
const bcrypt = require('bcryptjs');
const { db, norm, setSetting } = require('../db');
const lib = require('../lib');
const Q = require('../queries');

const TABLES = ['users', 'categories', 'businesses', 'products', 'promotions', 'redemptions', 'requests', 'proposals',
  'request_dismissals', 'events', 'reports', 'payments', 'settings', 'leads'];

module.exports = function adminRoutes() {
  const r = express.Router();
  const count = async (sql, ...p) => (await db.get(sql, ...p)).n;

  r.use(async (req, res, next) => {
    if (!req.user) return res.redirect('/ingresar?next=' + encodeURIComponent(req.originalUrl));
    if (req.user.role !== 'admin') return res.status(403).render('error', { title: 'Sin acceso', message: 'Esta sección es solo para administradores.' });
    res.locals.pendingCount = await count("SELECT COUNT(*) n FROM businesses WHERE status = 'pending'");
    res.locals.reportCount = await count('SELECT COUNT(*) n FROM reports WHERE resolved = 0');
    next();
  });

  // ---------- Resumen e indicadores ----------
  r.get('/', async (req, res) => {
    const now = lib.sqlNow(), d30 = lib.sqlDaysAgo(30);
    const all = await db.all('SELECT * FROM businesses');
    const approved = all.filter((b) => b.status === 'approved');
    const paid = approved.filter((b) => lib.effectivePlan(b) !== 'basico');
    const payingIds = new Set((await db.all('SELECT DISTINCT business_id FROM payments')).map((p) => p.business_id));
    const s = req.settings;
    const mrr = paid.filter((b) => payingIds.has(b.id)).reduce((a, b) => a + (lib.effectivePlan(b) === 'destacado' ? Number(s.price_destacado) : Number(s.price_pro)), 0);
    const activeBiz = await count(`SELECT COUNT(*) n FROM businesses WHERE status = 'approved' AND (updated_at > ?
      OR id IN (SELECT business_id FROM proposals WHERE created_at > ?))`, d30, d30);
    const weekly = await db.all(`SELECT to_char(created_at::timestamp, 'IYYY-IW') AS w, COUNT(*) n,
        SUM(CASE WHEN id IN (SELECT request_id FROM proposals) THEN 1 ELSE 0 END)::int AS answered
      FROM requests WHERE created_at > ? GROUP BY w ORDER BY w`, lib.sqlDaysAgo(56));
    const req30 = await count('SELECT COUNT(*) n FROM requests WHERE created_at > ?', d30);
    const ans30 = await count('SELECT COUNT(*) n FROM requests WHERE created_at > ? AND id IN (SELECT request_id FROM proposals)', d30);
    const contacts30 = await count("SELECT COUNT(*) n FROM events WHERE type LIKE 'click_%' AND created_at > ?", d30);
    const views30 = await count("SELECT COUNT(*) n FROM events WHERE type IN ('view','product_view') AND created_at > ?", d30);
    const redemptions30 = await count('SELECT COUNT(*) n FROM redemptions WHERE created_at > ?', d30);
    const everPaid = payingIds.size;
    const stillPaying = approved.filter((b) => payingIds.has(b.id) && lib.effectivePlan(b) !== 'basico').length;
    const expiring = approved.filter((b) => b.plan !== 'basico' && b.plan_until && b.plan_until > now && b.plan_until < lib.sqlPlusDays(7));
    const leads = await db.all('SELECT * FROM leads ORDER BY created_at DESC LIMIT 5');
    const pendingList = await db.all(`SELECT b.id, b.name, b.zone, b.created_at, b.whatsapp, c.name AS category_name, c.icon AS category_icon, u.email
      FROM businesses b JOIN users u ON u.id = b.owner_id LEFT JOIN categories c ON c.id = b.category_id
      WHERE b.status = 'pending' ORDER BY b.created_at LIMIT 6`);
    const viewRows = await db.all(`SELECT to_char(created_at::timestamp - interval '3 hours', 'YYYY-MM-DD') AS d, COUNT(*)::int AS n FROM events
      WHERE type IN ('view','product_view') AND created_at > ? GROUP BY d`, lib.sqlDaysAgo(15));
    const viewMap = Object.fromEntries(viewRows.map((v) => [v.d, v.n]));
    const daily = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - 3 * 3600000 - i * 86400000).toISOString().slice(0, 10);
      daily.push({ d, n: viewMap[d] || 0 });
    }
    res.render('admin/dashboard', {
      title: 'Resumen', stats: {
        total: all.length, approved: approved.length, pending: all.filter((b) => b.status === 'pending').length,
        paid: paid.length, mrr, activeBiz, req30, ans30, contacts30, views30, redemptions30, everPaid, stillPaying,
        products: await count('SELECT COUNT(*) n FROM products WHERE active = 1'),
      }, weekly, expiring, leads, pendingList, daily,
    });
  });

  // ---------- Comercios ----------
  r.get('/comercios', async (req, res) => {
    const estado = ['pending', 'approved', 'suspended'].includes(req.query.estado) ? req.query.estado : '';
    const q = lib.clip(req.query.q, 60);
    const where = [], params = [];
    if (estado) { where.push('b.status = ?'); params.push(estado); }
    if (q) { where.push("norm(b.name || ' ' || u.email) LIKE ?"); params.push(`%${norm(q)}%`); }
    const list = await db.all(`SELECT b.*, u.email, u.name AS owner_name, c.name AS category_name,
        (SELECT COUNT(*) FROM products p WHERE p.business_id = b.id) AS products
      FROM businesses b JOIN users u ON u.id = b.owner_id LEFT JOIN categories c ON c.id = b.category_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY CASE b.status WHEN 'pending' THEN 0 ELSE 1 END, b.created_at DESC`, ...params);
    list.forEach((b) => { b.effPlan = lib.effectivePlan(b); });
    const totals = { all: 0, pending: 0, approved: 0, suspended: 0 };
    for (const row of await db.all('SELECT status, COUNT(*)::int AS n FROM businesses GROUP BY status')) { totals[row.status] = row.n; totals.all += row.n; }
    res.render('admin/businesses', { title: 'Comercios', list, estado, q, totals });
  });

  r.get('/comercios/nuevo', (req, res) => res.render('admin/business-new', { title: 'Alta de comercio', error: null, form: {} }));
  r.post('/comercios/nuevo', async (req, res) => {
    const b = req.body;
    const email = lib.clip(b.email, 120).toLowerCase();
    const fail = (error) => res.status(400).render('admin/business-new', { title: 'Alta de comercio', error, form: b });
    if (!lib.clip(b.business_name, 80)) return fail('Falta el nombre del comercio.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Email inválido.');
    if (await db.get('SELECT id FROM users WHERE email = ?', email)) return fail('Ya existe una cuenta con ese email.');
    const pass = lib.clip(b.password, 100) || lib.token(6);
    const catId = lib.toInt(b.category_id);
    const cat = catId && await db.get('SELECT id FROM categories WHERE id = ?', catId);
    const trial = Number(req.settings.trial_days) || 30;
    const slug = await lib.uniqueSlug(b.business_name);
    const id = await db.tx(async (t) => {
      const uid = await t.insert("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'merchant')", email, bcrypt.hashSync(pass, 10), lib.clip(b.name, 80));
      return t.insert(`INSERT INTO businesses (owner_id, slug, name, category_id, whatsapp, phone, address, zone, plan, plan_until, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pro', ?, 'approved')`, uid, slug, lib.clip(b.business_name, 80),
      cat ? cat.id : null, lib.clip(b.whatsapp, 30), lib.clip(b.whatsapp, 30), lib.clip(b.address, 120), lib.clip(b.zone, 40), lib.sqlPlusDays(trial));
    });
    req.flash('ok', `Comercio creado con ${trial} días de prueba Pro. Acceso: ${email} / contraseña: ${pass} (pasásela al comerciante).`);
    res.redirect(`/admin/comercios/${id}`);
  });

  async function loadBiz(req, res, next) {
    const id = lib.toInt(req.params.id);
    const biz = id && await db.get(`SELECT b.*, u.email, u.name AS owner_name, c.name AS category_name FROM businesses b
      JOIN users u ON u.id = b.owner_id LEFT JOIN categories c ON c.id = b.category_id WHERE b.id = ?`, id);
    if (!biz) return next('route');
    req.biz = biz; next();
  }

  r.get('/comercios/:id', loadBiz, async (req, res) => {
    const biz = req.biz;
    biz.effPlan = lib.effectivePlan(biz);
    const payments = await db.all('SELECT * FROM payments WHERE business_id = ? ORDER BY created_at DESC', biz.id);
    const reports = await db.all('SELECT * FROM reports WHERE business_id = ? ORDER BY created_at DESC LIMIT 20', biz.id);
    const counts = {};
    (await db.all('SELECT type, COUNT(*) n FROM events WHERE business_id = ? AND created_at > ? GROUP BY type', biz.id, lib.sqlDaysAgo(30)))
      .forEach((e) => { counts[e.type] = e.n; });
    const products = await count('SELECT COUNT(*) n FROM products WHERE business_id = ?', biz.id);
    res.render('admin/business', { title: biz.name, biz, payments, reports, counts, products });
  });

  r.post('/comercios/:id/estado', loadBiz, async (req, res) => {
    const status = ['pending', 'approved', 'suspended'].includes(req.body.status) ? req.body.status : req.biz.status;
    let { plan, plan_until: until } = req.biz;
    if (status === 'approved' && !until) {
      // Primera aprobación: arranca la prueba gratuita Pro
      plan = 'pro'; until = lib.sqlPlusDays(Number(req.settings.trial_days) || 30);
    }
    await db.run('UPDATE businesses SET status = ?, plan = ?, plan_until = ? WHERE id = ?', status, plan, until, req.biz.id);
    req.flash('ok', status === 'approved' ? `“${req.biz.name}” ya está publicado.` : status === 'suspended' ? 'Comercio suspendido (no se muestra).' : 'Comercio en revisión.');
    const back = String(req.body.back || '');
    res.redirect(back.startsWith('/admin') && !back.startsWith('//') ? back : `/admin/comercios/${req.biz.id}`);
  });

  r.post('/comercios/:id/plan', loadBiz, async (req, res) => {
    const plan = ['basico', 'pro', 'destacado'].includes(req.body.plan) ? req.body.plan : 'basico';
    const until = /^\d{4}-\d{2}-\d{2}$/.test(req.body.plan_until || '') ? `${req.body.plan_until} 23:59:59` : null;
    await db.run('UPDATE businesses SET plan = ?, plan_until = ? WHERE id = ?', plan, plan === 'basico' ? null : until, req.biz.id);
    req.flash('ok', 'Plan actualizado.');
    res.redirect(`/admin/comercios/${req.biz.id}`);
  });

  r.post('/comercios/:id/pago', loadBiz, async (req, res) => {
    const plan = ['pro', 'destacado'].includes(req.body.plan) ? req.body.plan : 'pro';
    const months = Math.min(Math.max(lib.toInt(req.body.months) || 1, 1), 24);
    const s = req.settings;
    const amount = lib.toInt(req.body.amount) ?? (plan === 'destacado' ? Number(s.price_destacado) : Number(s.price_pro)) * months;
    // Extiende desde el vencimiento actual si sigue vigente (mismo plan), si no desde hoy.
    const from = req.biz.plan === plan && req.biz.plan_until && req.biz.plan_until > lib.sqlNow() ? req.biz.plan_until : null;
    const until = lib.sqlPlusDays(30 * months, from);
    await db.tx(async (t) => {
      await t.run('INSERT INTO payments (business_id, plan, months, amount, method, note) VALUES (?, ?, ?, ?, ?, ?)',
        req.biz.id, plan, months, amount, lib.clip(req.body.method, 40), lib.clip(req.body.note, 200));
      await t.run('UPDATE businesses SET plan = ?, plan_until = ? WHERE id = ?', plan, until, req.biz.id);
    });
    req.flash('ok', `Pago registrado. ${lib.PLAN_NAMES[plan]} vigente hasta ${lib.fmtDate(until)}.`);
    res.redirect(`/admin/comercios/${req.biz.id}`);
  });

  r.post('/comercios/:id/nota', loadBiz, async (req, res) => {
    await db.run('UPDATE businesses SET admin_note = ? WHERE id = ?', lib.clip(req.body.admin_note, 2000), req.biz.id);
    req.flash('ok', 'Nota guardada.');
    res.redirect(`/admin/comercios/${req.biz.id}`);
  });

  r.post('/comercios/:id/password', loadBiz, async (req, res) => {
    const pass = lib.clip(req.body.password, 100) || lib.token(6);
    await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(pass, 10), req.biz.owner_id);
    await db.run('DELETE FROM sessions WHERE sess LIKE ? OR sess LIKE ?', `%"userId":${req.biz.owner_id}}%`, `%"userId":${req.biz.owner_id},%`);
    req.flash('ok', `Nueva contraseña para ${req.biz.email}: ${pass}`);
    res.redirect(`/admin/comercios/${req.biz.id}`);
  });

  r.post('/comercios/:id/actuar', loadBiz, (req, res) => {
    req.session.actAs = req.biz.id;
    res.redirect('/panel');
  });
  r.post('/dejar-de-actuar', (req, res) => {
    const id = req.session.actAs;
    delete req.session.actAs;
    res.redirect(id ? `/admin/comercios/${id}` : '/admin/comercios');
  });

  r.post('/comercios/:id/borrar', loadBiz, async (req, res) => {
    if (req.body.confirm !== req.biz.slug) { req.flash('warn', 'Para borrar, escribí exactamente el identificador del comercio.'); return res.redirect(`/admin/comercios/${req.biz.id}`); }
    const imgs = (await db.all('SELECT photo FROM products WHERE business_id = ?', req.biz.id)).map((p) => p.photo);
    imgs.push(req.biz.logo, req.biz.cover);
    try { imgs.push(...JSON.parse(req.biz.gallery_json || '[]')); } catch { /* */ }
    await db.run('DELETE FROM users WHERE id = ?', req.biz.owner_id); // en cascada borra comercio y productos
    imgs.forEach(lib.deleteImage);
    req.flash('ok', 'Comercio y cuenta eliminados.');
    res.redirect('/admin/comercios');
  });

  // ---------- BUSCO YA ----------
  r.get('/pedidos', async (req, res) => {
    const list = await db.all(`SELECT r.*, c.name AS category_name, c.icon AS category_icon,
        (SELECT COUNT(*) FROM proposals p WHERE p.request_id = r.id) AS proposals
      FROM requests r LEFT JOIN categories c ON c.id = r.category_id ORDER BY r.created_at DESC LIMIT 200`);
    const now = lib.sqlNow();
    const byCat = {};
    for (const rq of list) {
      if (!byCat[rq.category_id]) byCat[rq.category_id] = await Q.matchingBusinessesForRequest(rq);
      rq.matches = byCat[rq.category_id];
      rq.expired = rq.expires_at < now;
    }
    res.render('admin/requests', { title: 'Pedidos BUSCO YA', list });
  });
  r.post('/pedidos/:id/estado', async (req, res) => {
    const status = ['open', 'closed', 'hidden'].includes(req.body.status) ? req.body.status : 'hidden';
    await db.run('UPDATE requests SET status = ? WHERE id = ?', status, lib.toInt(req.params.id));
    req.flash('ok', status === 'hidden' ? 'Pedido ocultado.' : 'Estado actualizado.');
    res.redirect('/admin/pedidos');
  });

  // ---------- Reportes ----------
  r.get('/reportes', async (req, res) => {
    const list = await db.all(`SELECT rp.*, b.name AS business_name, b.slug AS business_slug, p.name AS product_name, rq.description AS request_description, rq.token AS request_token
      FROM reports rp LEFT JOIN businesses b ON b.id = rp.business_id LEFT JOIN products p ON p.id = rp.product_id
      LEFT JOIN requests rq ON rq.id = rp.request_id ORDER BY rp.resolved, rp.created_at DESC LIMIT 200`);
    res.render('admin/reports', { title: 'Reportes', list });
  });
  r.post('/reportes/:id/resolver', async (req, res) => {
    await db.run('UPDATE reports SET resolved = 1 WHERE id = ?', lib.toInt(req.params.id));
    res.redirect('/admin/reportes');
  });

  // ---------- Contactos ----------
  r.get('/contactos', async (req, res) => {
    res.render('admin/leads', { title: 'Contactos de comercios', list: await db.all('SELECT * FROM leads ORDER BY created_at DESC LIMIT 300') });
  });
  r.post('/contactos/:id/borrar', async (req, res) => {
    await db.run('DELETE FROM leads WHERE id = ?', lib.toInt(req.params.id));
    res.redirect('/admin/contactos');
  });

  // ---------- Ajustes ----------
  r.get('/ajustes', (req, res) => res.render('admin/settings', { title: 'Ajustes' }));
  r.post('/ajustes', async (req, res) => {
    const keys = ['price_pro', 'price_destacado', 'trial_days', 'basic_product_limit', 'pro_product_limit', 'request_days', 'requests_per_day'];
    for (const k of keys) if (req.body[k] !== undefined) await setSetting(k, lib.toInt(req.body[k]) ?? 0);
    for (const k of ['contact_whatsapp', 'contact_email', 'payment_instructions', 'instagram']) {
      if (req.body[k] !== undefined) await setSetting(k, lib.clip(req.body[k], 1500));
    }
    req.flash('ok', 'Ajustes guardados.');
    res.redirect('/admin/ajustes');
  });
  // ---------- Rubros (categorías) ----------
  r.get('/rubros', async (req, res) => {
    const list = await db.all(`SELECT c.*,
        (SELECT COUNT(*)::int FROM businesses b WHERE b.category_id = c.id) AS businesses,
        (SELECT COUNT(*)::int FROM businesses b WHERE b.category_id = c.id AND b.status = 'approved') AS published,
        (SELECT COUNT(*)::int FROM requests q WHERE q.category_id = c.id) AS requests
      FROM categories c ORDER BY c.sort, c.id`);
    res.render('admin/categories', { title: 'Rubros', list });
  });
  r.post('/categorias', async (req, res) => {
    const name = lib.clip(req.body.name, 60);
    if (!name) { req.flash('warn', 'Escribí el nombre del rubro.'); return res.redirect('/admin/rubros'); }
    let slug = lib.slugify(name), i = 2;
    while (await db.get('SELECT id FROM categories WHERE slug = ?', slug)) slug = `${lib.slugify(name)}-${i++}`;
    const max = (await db.get('SELECT MAX(sort) AS m FROM categories')).m || 0;
    await db.run('INSERT INTO categories (slug, name, icon, sort) VALUES (?, ?, ?, ?)', slug, name, lib.clip(req.body.icon, 8) || '🏪', max + 1);
    req.flash('ok', `Rubro “${name}” agregado.`);
    res.redirect('/admin/rubros');
  });
  r.post('/categorias/:id', async (req, res) => {
    const name = lib.clip(req.body.name, 60);
    if (name) {
      await db.run('UPDATE categories SET name = ?, icon = ? WHERE id = ?', name, lib.clip(req.body.icon, 8) || '🏪', lib.toInt(req.params.id));
      req.flash('ok', 'Rubro actualizado.');
    }
    res.redirect('/admin/rubros');
  });
  // Mover un rubro una posición arriba o abajo en la lista.
  r.post('/categorias/:id/mover', async (req, res) => {
    const id = lib.toInt(req.params.id);
    const dir = req.body.dir === 'up' ? -1 : 1;
    const all = await db.all('SELECT id FROM categories ORDER BY sort, id');
    const i = all.findIndex((c) => c.id === id), j = i + dir;
    if (i >= 0 && j >= 0 && j < all.length) {
      [all[i], all[j]] = [all[j], all[i]];
      await db.tx(async (t) => { for (let k = 0; k < all.length; k++) await t.run('UPDATE categories SET sort = ? WHERE id = ?', k, all[k].id); });
    }
    res.redirect('/admin/rubros#c' + id);
  });
  // Eliminar un rubro. Los comercios y pedidos que lo usan se pasan a otro rubro (o quedan sin rubro).
  r.post('/categorias/:id/borrar', async (req, res) => {
    const id = lib.toInt(req.params.id);
    const cat = id && await db.get('SELECT * FROM categories WHERE id = ?', id);
    if (!cat) { req.flash('warn', 'Ese rubro ya no existe.'); return res.redirect('/admin/rubros'); }
    const target = lib.toInt(req.body.move_to);
    const dest = target && target !== id ? await db.get('SELECT id, name FROM categories WHERE id = ?', target) : null;
    const used = (await db.get('SELECT COUNT(*)::int AS n FROM businesses WHERE category_id = ?', id)).n;
    await db.tx(async (t) => {
      await t.run('UPDATE businesses SET category_id = ? WHERE category_id = ?', dest ? dest.id : null, id);
      await t.run('UPDATE requests SET category_id = ? WHERE category_id = ?', dest ? dest.id : null, id);
      await t.run('DELETE FROM categories WHERE id = ?', id);
    });
    req.flash('ok', used
      ? `Rubro “${cat.name}” eliminado. ${lib.plural(used, 'comercio pasó', 'comercios pasaron')} a ${dest ? '“' + dest.name + '”' : 'estado “sin rubro”'}.`
      : `Rubro “${cat.name}” eliminado.`);
    res.redirect('/admin/rubros');
  });

  // ---------- Datos de demostración (para mostrarle el sitio a comercios) ----------
  r.post('/demo/cargar', async (req, res) => {
    const out = await require('../../scripts/seed-demo').seed();
    req.flash('ok', out.created ? `Listo: se cargaron ${lib.plural(out.created, 'comercio de ejemplo', 'comercios de ejemplo')}.` : 'Los comercios de ejemplo ya estaban cargados.');
    res.redirect('/admin/ajustes#demo');
  });
  r.post('/demo/borrar', async (req, res) => {
    const out = await require('../../scripts/seed-demo').clear();
    req.flash('ok', `Se borraron ${lib.plural(out.removed, 'comercio de ejemplo', 'comercios de ejemplo')}.`);
    res.redirect('/admin/ajustes#demo');
  });

  // ---------- Copia de seguridad (todas las tablas en JSON; las fotos ya están en R2) ----------
  r.get('/respaldo', async (req, res) => {
    const out = { exported_at: new Date().toISOString(), tables: {} };
    for (const t of TABLES) out.tables[t] = await db.all(`SELECT * FROM ${t}`);
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="pulso-respaldo-${stamp}.json"`);
    res.type('application/json').send(JSON.stringify(out));
  });

  r.post('/cuenta', async (req, res) => {
    const u = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    if (!bcrypt.compareSync(String(req.body.current || ''), u.password_hash) || String(req.body.password || '').length < 8) {
      req.flash('warn', 'Contraseña actual incorrecta o nueva demasiado corta (mín. 8).');
    } else {
      await db.run('UPDATE users SET password_hash = ? WHERE id = ?', bcrypt.hashSync(req.body.password, 10), u.id);
      req.flash('ok', 'Contraseña de administrador actualizada.');
    }
    res.redirect('/admin/ajustes');
  });

  return r;
};
