const express = require('express');
const bcrypt = require('bcryptjs');
const { db, NOW } = require('../db');
const lib = require('../lib');
const Q = require('../queries');

const AVAIL = ['disponible', 'pocas', 'a_pedido', 'sin_stock'];
const DELIVERY = ['retiro', 'envio', 'ambos'];

module.exports = function merchantRoutes(upload, checkCsrf) {
  const r = express.Router();

  function pendingRequests(biz) {
    return db.all(`SELECT r.*, c.name AS category_name, c.icon AS category_icon FROM requests r
      LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.status = 'open' AND r.expires_at > ? AND r.category_id = ?
        AND r.id NOT IN (SELECT request_id FROM proposals WHERE business_id = ?)
        AND r.id NOT IN (SELECT request_id FROM request_dismissals WHERE business_id = ?)
      ORDER BY r.created_at DESC`, lib.sqlNow(), biz.category_id, biz.id, biz.id);
  }
  const touch = (bizId) => db.run(`UPDATE businesses SET updated_at = ${NOW} WHERE id = ?`, bizId);
  const count = async (sql, ...p) => (await db.get(sql, ...p)).n;

  // Acceso: dueño del comercio, o admin "actuando como" un comercio (para ayudar a cargar fichas).
  r.use(async (req, res, next) => {
    if (!req.user) return res.redirect('/ingresar?next=' + encodeURIComponent(req.originalUrl));
    if (req.user.role === 'admin') {
      if (!req.session.actAs) return res.redirect('/admin/comercios');
      req.business = await db.get('SELECT * FROM businesses WHERE id = ?', req.session.actAs);
      if (!req.business) { delete req.session.actAs; return res.redirect('/admin/comercios'); }
      res.locals.actingAs = req.business;
    }
    if (!req.business) return res.render('error', { title: 'Sin comercio', message: 'Tu cuenta no tiene un comercio asociado. Escribinos para resolverlo.' });
    req.plan = lib.effectivePlan(req.business);
    req.limits = lib.planLimits(req.plan, req.settings);
    const openReqs = req.limits.buscoYa ? (await pendingRequests(req.business)).length : 0;
    Object.assign(res.locals, { biz: req.business, plan: req.plan, limits: req.limits, openReqs, myBusiness: req.business });
    next();
  });

  // ---------- Resumen ----------
  r.get('/', async (req, res) => {
    const biz = req.business;
    const days = [7, 30, 90].includes(Number(req.query.dias)) ? Number(req.query.dias) : 30;
    const since = lib.sqlDaysAgo(days);
    const counts = {};
    (await db.all('SELECT type, COUNT(*) n FROM events WHERE business_id = ? AND created_at > ? GROUP BY type', biz.id, since))
      .forEach((e) => { counts[e.type] = e.n; });
    const daily = await db.all(`SELECT to_char(created_at::timestamp - interval '3 hours', 'YYYY-MM-DD') AS d, COUNT(*) n FROM events
      WHERE business_id = ? AND type IN ('view','product_view') AND created_at > ? GROUP BY d ORDER BY d`, biz.id, since);
    const clicks = Object.entries(counts).filter(([k]) => k.startsWith('click_')).reduce((a, [, n]) => a + n, 0);
    const topProducts = await db.all(`SELECT p.id, p.name, COUNT(e.id) AS views,
        SUM(CASE WHEN e.type = 'click_whatsapp' THEN 1 ELSE 0 END)::int AS wa
      FROM events e JOIN products p ON p.id = e.product_id WHERE e.business_id = ? AND e.created_at > ?
      GROUP BY p.id, p.name ORDER BY views DESC LIMIT 5`, biz.id, since);
    const redemptions = await count('SELECT COUNT(*) n FROM redemptions WHERE business_id = ? AND created_at > ?', biz.id, since);
    const proposalsSent = await count('SELECT COUNT(*) n FROM proposals WHERE business_id = ? AND created_at > ?', biz.id, since);
    const productCount = await count('SELECT COUNT(*) n FROM products WHERE business_id = ?', biz.id);
    const checklist = [
      { ok: !!biz.description && biz.description.length > 30, label: 'Descripción del comercio', href: '/panel/ficha' },
      { ok: !!biz.address, label: 'Dirección', href: '/panel/ficha' },
      { ok: lib.hasHours(biz.hours_json), label: 'Horarios de atención', href: '/panel/ficha#horarios' },
      { ok: !!biz.logo || !!biz.cover, label: 'Logo o foto de portada', href: '/panel/ficha' },
      { ok: productCount >= 3, label: 'Al menos 3 productos publicados', href: '/panel/productos/nuevo' },
    ];
    res.render('panel/dashboard', { title: 'Mi panel', days, counts, clicks, daily, topProducts, redemptions, proposalsSent, checklist, productCount });
  });

  // ---------- Ficha ----------
  r.get('/ficha', async (req, res) => {
    let gallery = [];
    try { gallery = JSON.parse(req.business.gallery_json || '[]'); } catch { gallery = []; }
    res.render('panel/profile', { title: 'Mi ficha', hours: lib.parseHours(req.business.hours_json), gallery, zones: await Q.zones() });
  });

  r.post('/ficha', upload.fields([{ name: 'logo', maxCount: 1 }, { name: 'cover', maxCount: 1 }, { name: 'gallery', maxCount: 6 }]), checkCsrf, async (req, res) => {
    const b = req.body, biz = req.business;
    const name = lib.clip(b.name, 80) || biz.name;
    const catId = lib.toInt(b.category_id);
    const cat = catId && await db.get('SELECT id FROM categories WHERE id = ?', catId);
    const hours = {};
    for (let d = 0; d < 7; d++) {
      const ranges = [];
      if (b[`h${d}_closed`]) { hours[d] = []; continue; }
      for (const k of ['a', 'b']) {
        const o = b[`h${d}_${k}_open`], c = b[`h${d}_${k}_close`];
        if (/^\d{2}:\d{2}$/.test(o || '') && /^\d{2}:\d{2}$/.test(c || '')) ranges.push([o, c]);
      }
      hours[d] = ranges;
    }
    let gallery = [];
    try { gallery = JSON.parse(biz.gallery_json || '[]'); } catch { gallery = []; }
    const remove = [].concat(b.remove_gallery || []);
    gallery = gallery.filter((g) => { if (remove.includes(g)) { lib.deleteImage(g); return false; } return true; });
    const files = req.files || {};
    for (const f of files.gallery || []) if (gallery.length < 6) gallery.push(await lib.saveImage(f));
    let logo = biz.logo, cover = biz.cover;
    if (files.logo && files.logo[0]) { lib.deleteImage(logo); logo = await lib.saveImage(files.logo[0], { width: 400, height: 400, fit: 'cover', thumb: 160 }); }
    if (files.cover && files.cover[0]) { lib.deleteImage(cover); cover = await lib.saveImage(files.cover[0], { width: 1600, height: 900, thumb: 640 }); }
    if (b.remove_logo) { lib.deleteImage(logo); logo = ''; }
    if (b.remove_cover) { lib.deleteImage(cover); cover = ''; }
    const slug = name !== biz.name ? await lib.uniqueSlug(name, biz.id) : biz.slug;
    await db.run(`UPDATE businesses SET name = ?, slug = ?, category_id = ?, description = ?, address = ?, zone = ?, directions = ?, maps_url = ?,
        phone = ?, whatsapp = ?, website = ?, instagram = ?, facebook = ?, hours_json = ?, logo = ?, cover = ?, gallery_json = ?, delivery = ?,
        updated_at = ${NOW} WHERE id = ?`,
    name, slug, cat ? cat.id : biz.category_id, lib.clip(b.description, 1500), lib.clip(b.address, 120), lib.clip(b.zone, 40),
    lib.clip(b.directions, 300), lib.safeUrl(b.maps_url), lib.clip(b.phone, 30), lib.clip(b.whatsapp, 30), lib.safeUrl(b.website),
    lib.clip(b.instagram, 120), lib.safeUrl(b.facebook), JSON.stringify(hours), logo, cover, JSON.stringify(gallery),
    DELIVERY.includes(b.delivery) ? b.delivery : 'retiro', biz.id);
    req.flash('ok', 'Ficha guardada.');
    res.redirect('/panel/ficha');
  });

  // ---------- Productos ----------
  r.get('/productos', async (req, res) => {
    const products = await db.all('SELECT * FROM products WHERE business_id = ? ORDER BY active DESC, updated_at DESC, id DESC', req.business.id);
    res.render('panel/products', { title: 'Mis productos', products });
  });

  function productForm(res, product, error) {
    res.render('panel/product-form', { title: product.id ? 'Editar producto' : 'Nuevo producto', product, error });
  }
  r.get('/productos/nuevo', async (req, res) => {
    const n = await count('SELECT COUNT(*) n FROM products WHERE business_id = ?', req.business.id);
    if (n >= req.limits.products) {
      req.flash('warn', `Tu plan permite hasta ${req.limits.products} productos. Pasate a Comercio Pro para publicar más.`);
      return res.redirect('/panel/plan');
    }
    productForm(res, { availability: 'disponible', active: 1 }, null);
  });
  r.get('/productos/:id', async (req, res, next) => {
    const id = lib.toInt(req.params.id);
    const p = id && await db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', id, req.business.id);
    if (!p) return next();
    productForm(res, p, null);
  });

  async function saveProduct(req, res, next) {
    const b = req.body, bizId = req.business.id;
    const pid = req.params.id ? lib.toInt(req.params.id) : null;
    const existing = pid ? await db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', pid, bizId) : null;
    if (req.params.id && !existing) return next();
    const data = {
      name: lib.clip(b.name, 100), description: lib.clip(b.description, 1500), price: lib.toInt(b.price),
      price_note: lib.clip(b.price_note, 60), availability: AVAIL.includes(b.availability) ? b.availability : 'disponible',
      active: b.active ? 1 : 0,
    };
    if (!data.name) return productForm(res, { ...existing, ...data }, 'Poné un nombre al producto.');
    if (!existing) {
      const n = await count('SELECT COUNT(*) n FROM products WHERE business_id = ?', bizId);
      if (n >= req.limits.products) return productForm(res, data, `Llegaste al límite de ${req.limits.products} productos de tu plan.`);
    }
    let photo = existing ? existing.photo : '';
    if (req.file) { lib.deleteImage(photo); photo = await lib.saveImage(req.file); }
    if (b.remove_photo && !req.file) { lib.deleteImage(photo); photo = ''; }
    if (existing) {
      await db.run(`UPDATE products SET name = ?, description = ?, price = ?, price_note = ?, availability = ?, active = ?, photo = ?,
        updated_at = ${NOW} WHERE id = ?`, data.name, data.description, data.price, data.price_note, data.availability, data.active, photo, existing.id);
    } else {
      await db.run(`INSERT INTO products (business_id, name, description, price, price_note, availability, active, photo)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, bizId, data.name, data.description, data.price, data.price_note, data.availability, data.active, photo);
    }
    await touch(bizId);
    req.flash('ok', existing ? 'Producto actualizado.' : 'Producto publicado.');
    res.redirect(b.otro ? '/panel/productos/nuevo' : '/panel/productos');
  }
  r.post('/productos/nuevo', upload.single('photo'), checkCsrf, saveProduct);
  r.post('/productos/:id', upload.single('photo'), checkCsrf, saveProduct);

  r.post('/productos/:id/estado', async (req, res) => {
    const id = lib.toInt(req.params.id);
    const p = id && await db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', id, req.business.id);
    if (p) {
      if (req.body.availability && AVAIL.includes(req.body.availability)) {
        await db.run(`UPDATE products SET availability = ?, updated_at = ${NOW} WHERE id = ?`, req.body.availability, p.id);
      } else {
        await db.run(`UPDATE products SET active = ?, updated_at = ${NOW} WHERE id = ?`, p.active ? 0 : 1, p.id);
      }
      await touch(req.business.id);
    }
    res.redirect('/panel/productos');
  });
  r.post('/productos/:id/borrar', async (req, res) => {
    const id = lib.toInt(req.params.id);
    const p = id && await db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', id, req.business.id);
    if (p) { lib.deleteImage(p.photo); await db.run('DELETE FROM products WHERE id = ?', p.id); req.flash('ok', 'Producto eliminado.'); }
    res.redirect('/panel/productos');
  });

  // ---------- Promociones ----------
  r.get('/promociones', async (req, res) => {
    const promos = await db.all(`SELECT pr.*, (SELECT COUNT(*) FROM redemptions x WHERE x.promotion_id = pr.id) AS canjes
      FROM promotions pr WHERE business_id = ? ORDER BY ends_at DESC`, req.business.id);
    res.render('panel/promotions', { title: 'Promociones', promos, today: lib.todayAR(), error: null });
  });
  r.post('/promociones', upload.single('photo'), checkCsrf, async (req, res) => {
    if (!req.limits.promos) { req.flash('warn', 'Las promociones están incluidas en Comercio Pro.'); return res.redirect('/panel/plan'); }
    const b = req.body;
    const title = lib.clip(b.title, 100), starts = lib.clip(b.starts_at, 10), ends = lib.clip(b.ends_at, 10);
    if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(starts) || !/^\d{4}-\d{2}-\d{2}$/.test(ends) || ends < starts) {
      req.flash('warn', 'Completá el título y una vigencia válida (desde / hasta).');
      return res.redirect('/panel/promociones');
    }
    if (!lib.clip(b.conditions, 10)) { req.flash('warn', 'Indicá las condiciones de la promoción (es obligatorio para generar confianza).'); return res.redirect('/panel/promociones'); }
    const photo = req.file ? await lib.saveImage(req.file) : '';
    const code = lib.clip(b.code, 20).toUpperCase() || ('PL' + lib.token(3).toUpperCase().replace(/[^A-Z0-9]/g, 'X'));
    await db.run('INSERT INTO promotions (business_id, title, description, conditions, starts_at, ends_at, code, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      req.business.id, title, lib.clip(b.description, 600), lib.clip(b.conditions, 600), starts, ends, code, photo);
    await touch(req.business.id);
    req.flash('ok', 'Promoción publicada.');
    res.redirect('/panel/promociones');
  });
  r.post('/promociones/:id/borrar', async (req, res) => {
    const id = lib.toInt(req.params.id);
    const p = id && await db.get('SELECT * FROM promotions WHERE id = ? AND business_id = ?', id, req.business.id);
    if (p) { lib.deleteImage(p.photo); await db.run('DELETE FROM promotions WHERE id = ?', p.id); req.flash('ok', 'Promoción eliminada.'); }
    res.redirect('/panel/promociones');
  });
  r.post('/promociones/:id/finalizar', async (req, res) => {
    const yesterday = new Date(Date.now() - 86400000 - 3 * 3600000).toISOString().slice(0, 10);
    await db.run('UPDATE promotions SET ends_at = ? WHERE id = ? AND business_id = ?', yesterday, lib.toInt(req.params.id), req.business.id);
    req.flash('ok', 'Promoción finalizada.');
    res.redirect('/panel/promociones');
  });
  r.post('/canje', async (req, res) => {
    const code = lib.clip(req.body.code, 20).toUpperCase();
    const today = lib.todayAR();
    const promo = await db.get('SELECT * FROM promotions WHERE business_id = ? AND upper(code) = ?', req.business.id, code);
    if (!promo) req.flash('warn', `El código ${code} no corresponde a ninguna promoción de tu comercio.`);
    else if (promo.starts_at > today || promo.ends_at < today) req.flash('warn', `La promoción “${promo.title}” no está vigente hoy.`);
    else {
      await db.run('INSERT INTO redemptions (promotion_id, business_id, note) VALUES (?, ?, ?)', promo.id, req.business.id, lib.clip(req.body.note, 120));
      await lib.track(req.business.id, 'redemption');
      req.flash('ok', `Canje registrado para “${promo.title}”.`);
    }
    res.redirect(req.body.from === 'panel' ? '/panel' : '/panel/promociones');
  });

  // ---------- BUSCO YA: pedidos ----------
  r.get('/pedidos', async (req, res) => {
    const open = req.limits.buscoYa ? await pendingRequests(req.business) : [];
    const lockedCount = req.limits.buscoYa ? 0
      : await count("SELECT COUNT(*) n FROM requests WHERE category_id = ? AND status = 'open' AND expires_at > ?", req.business.category_id, lib.sqlNow());
    const sent = await db.all(`SELECT p.*, r.description AS request_description, r.name AS request_name, r.status AS request_status, r.expires_at,
        (SELECT COUNT(*) FROM proposals x WHERE x.request_id = r.id) AS competitors
      FROM proposals p JOIN requests r ON r.id = p.request_id WHERE p.business_id = ? ORDER BY p.created_at DESC LIMIT 50`, req.business.id);
    const myProducts = await db.all('SELECT id, name FROM products WHERE business_id = ? AND active = 1 ORDER BY name', req.business.id);
    res.render('panel/requests', { title: 'Pedidos BUSCO YA', open, sent, lockedCount, myProducts });
  });
  r.post('/pedidos/:id/responder', upload.single('photo'), checkCsrf, async (req, res) => {
    if (!req.limits.buscoYa) return res.redirect('/panel/plan');
    if (req.business.status !== 'approved') { req.flash('warn', 'Podés responder cuando tu ficha esté publicada.'); return res.redirect('/panel/pedidos'); }
    const rq = await db.get("SELECT * FROM requests WHERE id = ? AND status = 'open' AND expires_at > ? AND category_id = ?",
      lib.toInt(req.params.id), lib.sqlNow(), req.business.category_id);
    if (!rq) { req.flash('warn', 'Ese pedido ya no está disponible.'); return res.redirect('/panel/pedidos'); }
    const b = req.body;
    const message = lib.clip(b.message, 800);
    if (!message) { req.flash('warn', 'Escribí un mensaje para tu propuesta.'); return res.redirect('/panel/pedidos#r' + rq.id); }
    let photo = req.file ? await lib.saveImage(req.file, { width: 1000, height: 1000 }) : '';
    const pid = lib.toInt(b.product_id);
    if (!photo && pid) {
      const prod = await db.get('SELECT photo FROM products WHERE id = ? AND business_id = ?', pid, req.business.id);
      if (prod) photo = prod.photo;
    }
    await db.run(`INSERT INTO proposals (request_id, business_id, price, message, availability, delivery, photo) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (request_id, business_id) DO UPDATE SET price = excluded.price, message = excluded.message, availability = excluded.availability,
      delivery = excluded.delivery, photo = excluded.photo`, rq.id, req.business.id, lib.toInt(b.price), message,
    AVAIL.includes(b.availability) ? b.availability : 'disponible', DELIVERY.includes(b.delivery) ? b.delivery : 'retiro', photo);
    await lib.track(req.business.id, 'proposal_sent');
    req.flash('ok', 'Propuesta enviada. El vecino la verá y podrá escribirte por WhatsApp.');
    res.redirect('/panel/pedidos');
  });
  r.post('/pedidos/:id/descartar', async (req, res) => {
    await db.run('INSERT INTO request_dismissals (request_id, business_id) VALUES (?, ?) ON CONFLICT DO NOTHING', lib.toInt(req.params.id), req.business.id);
    res.redirect('/panel/pedidos');
  });
  r.post('/pedidos/:id/reportar', async (req, res) => {
    const id = lib.toInt(req.params.id);
    await db.run('INSERT INTO reports (request_id, reason, details) VALUES (?, ?, ?)', id, 'Pedido inapropiado o falso', `Reportado por ${req.business.name}`);
    await db.run('INSERT INTO request_dismissals (request_id, business_id) VALUES (?, ?) ON CONFLICT DO NOTHING', id, req.business.id);
    req.flash('ok', 'Gracias. Vamos a revisar ese pedido.');
    res.redirect('/panel/pedidos');
  });

  // ---------- Plan ----------
  r.get('/plan', async (req, res) => {
    const payments = await db.all('SELECT * FROM payments WHERE business_id = ? ORDER BY created_at DESC', req.business.id);
    const productCount = await count('SELECT COUNT(*) n FROM products WHERE business_id = ?', req.business.id);
    res.render('panel/plan', { title: 'Mi plan', payments, productCount });
  });

  // ---------- QR para vidriera ----------
  r.get('/qr', (req, res) => res.render('panel/qr', { title: 'QR para tu vidriera' }));

  // ---------- Cuenta ----------
  r.get('/cuenta', (req, res) => res.render('panel/account', { title: 'Mi cuenta', error: null }));
  r.post('/cuenta', async (req, res) => {
    if (req.user.role === 'admin') return res.redirect('/panel');
    const u = await db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    const fail = (error) => res.status(400).render('panel/account', { title: 'Mi cuenta', error });
    if (!bcrypt.compareSync(String(req.body.current || ''), u.password_hash)) return fail('La contraseña actual no es correcta.');
    const email = lib.clip(req.body.email, 120).toLowerCase() || u.email;
    if (email !== u.email && await db.get('SELECT id FROM users WHERE email = ?', email)) return fail('Ese email ya está en uso.');
    let hash = u.password_hash;
    if (req.body.password) {
      if (req.body.password.length < 8) return fail('La nueva contraseña debe tener al menos 8 caracteres.');
      hash = bcrypt.hashSync(req.body.password, 10);
    }
    await db.run('UPDATE users SET email = ?, name = ?, password_hash = ? WHERE id = ?', email, lib.clip(req.body.name, 80) || u.name, hash, u.id);
    req.flash('ok', 'Datos de la cuenta actualizados.');
    res.redirect('/panel/cuenta');
  });

  return r;
};
