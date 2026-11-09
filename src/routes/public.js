const express = require('express');
const QRCode = require('qrcode');
const { db } = require('../db');
const lib = require('../lib');
const Q = require('../queries');

module.exports = function publicRoutes(upload, checkCsrf) {
  const r = express.Router();

  // ---------- Inicio ----------
  r.get('/', async (req, res) => {
    const [featured, promos, products, all, stats1, stats2, stats3, openRequests, catStats, zoneList] = await Promise.all([
      Q.sponsored({ limit: 6 }),
      Q.activePromotions({ limit: 8 }),
      Q.searchProducts({ limit: 12 }),
      Q.searchBusinesses({ limit: 200 }),
      db.get("SELECT COUNT(*) n FROM businesses WHERE status = 'approved'"),
      db.get("SELECT COUNT(*) n FROM products p JOIN businesses b ON b.id = p.business_id WHERE p.active = 1 AND b.status = 'approved'"),
      db.get("SELECT COUNT(*) n FROM requests WHERE status = 'open' AND expires_at > ?", lib.sqlNow()),
      db.all(`SELECT r.id, r.description, r.zone, r.budget, r.created_at, c.name AS category_name, c.icon AS category_icon
        FROM requests r LEFT JOIN categories c ON c.id = r.category_id
        WHERE r.status = 'open' AND r.expires_at > ? ORDER BY r.created_at DESC LIMIT 4`, lib.sqlNow()),
      db.all(`SELECT c.slug, c.name, c.icon, COUNT(b.id)::int AS n FROM categories c
        LEFT JOIN businesses b ON b.category_id = c.id AND b.status = 'approved' GROUP BY c.id ORDER BY c.sort, c.id`),
      Q.zones(),
    ]);
    const openNow = all.filter((b) => b.open).slice(0, 8);
    const recent = all.slice(0, 8);
    res.render('home', {
      title: '', featured, promos, products, openNow, recent, openRequests, catStats, zoneList: zoneList.slice(0, 12),
      stats: { businesses: stats1.n, products: stats2.n, requests: stats3.n, openNow: all.filter((b) => b.open).length },
    });
  });

  // ---------- Buscador ----------
  r.get('/buscar', async (req, res) => {
    const q = lib.clip(req.query.q, 80);
    const cat = lib.clip(req.query.cat, 40);
    const zona = lib.clip(req.query.zona, 40);
    const abierto = req.query.abierto === '1';
    const tipo = ['productos', 'comercios'].includes(req.query.tipo) ? req.query.tipo : 'todo';
    const min = lib.toInt(req.query.min), max = lib.toInt(req.query.max);
    const sort = lib.clip(req.query.orden, 20);
    const page = Math.max(1, Number(req.query.pag) || 1);
    const per = tipo === 'todo' ? 24 : 48;

    let businesses = [], products = [];
    if (tipo !== 'productos') {
      businesses = await Q.searchBusinesses({ q, cat, zona, limit: abierto ? 500 : per + 1, offset: abierto ? 0 : (page - 1) * per });
      if (abierto) businesses = businesses.filter((b) => b.open).slice((page - 1) * per, page * per + 1);
    }
    if (tipo !== 'comercios') {
      products = await Q.searchProducts({ q, cat, zona, min, max, sort, limit: abierto ? 1000 : per + 1, offset: abierto ? 0 : (page - 1) * per });
      if (abierto) products = products.filter((p) => p.open).slice((page - 1) * per, page * per + 1);
    }
    const more = businesses.length > per || products.length > per;
    businesses = businesses.slice(0, per); products = products.slice(0, per);
    const sponsoredList = page === 1 && tipo !== 'productos' ? (await Q.sponsored({ cat, zona, limit: 2 })).filter((b) => !abierto || b.open) : [];
    const catRow = cat ? await db.get('SELECT * FROM categories WHERE slug = ?', cat) : null;
    res.render('search', {
      title: q ? `Resultados para “${q}”` : catRow ? catRow.name : 'Buscar en Luján',
      q, cat, catRow, zona, abierto, tipo, min, max, sort, page, more, businesses, products, sponsoredList, zones: await Q.zones(),
    });
  });

  r.get('/categoria/:slug', (req, res) => res.redirect(301, `/buscar?cat=${encodeURIComponent(req.params.slug)}`));

  // ---------- Ficha del comercio ----------
  r.get('/c/:slug', async (req, res, next) => {
    const biz = await db.get(`SELECT b.*, c.name AS category_name, c.icon AS category_icon, c.slug AS category_slug
      FROM businesses b LEFT JOIN categories c ON c.id = b.category_id WHERE b.slug = ?`, req.params.slug);
    const isOwner = biz && req.user && (req.user.id === biz.owner_id || req.user.role === 'admin');
    if (!biz || (biz.status !== 'approved' && !isOwner)) return next();
    Q.decorateBiz(biz);
    if (!isOwner) await lib.track(biz.id, 'view');
    const products = biz.status === 'approved'
      ? await Q.searchProducts({ businessId: biz.id, limit: 500 })
      : await db.all('SELECT * FROM products WHERE business_id = ? AND active = 1 ORDER BY updated_at DESC', biz.id);
    const promos = await Q.activePromotions({ businessId: biz.id });
    let gallery = [];
    try { gallery = JSON.parse(biz.gallery_json || '[]'); } catch { gallery = []; }
    res.render('business', {
      title: biz.name, description: lib.clip(biz.description, 155) || `${biz.name} en Luján`,
      biz, products, promos, gallery, hours: lib.hoursRows(biz.hours_json), isOwner,
      ogImage: biz.cover || biz.logo,
    });
  });

  // ---------- Producto ----------
  r.get('/p/:id', async (req, res, next) => {
    const id = lib.toInt(req.params.id);
    if (!id) return next();
    const p = await db.get(`SELECT p.*, b.slug AS business_slug, b.name AS business_name, b.status, b.owner_id, b.whatsapp, b.phone,
        b.website, b.address, b.zone, b.hours_json, b.updated_at AS business_updated, b.delivery, b.logo, c.name AS category_name, c.slug AS category_slug
      FROM products p JOIN businesses b ON b.id = p.business_id LEFT JOIN categories c ON c.id = b.category_id WHERE p.id = ?`, id);
    const isOwner = p && req.user && (req.user.id === p.owner_id || req.user.role === 'admin');
    if (!p || ((p.status !== 'approved' || !p.active) && !isOwner)) return next();
    p.open = lib.isOpenNow(p.hours_json);
    if (!isOwner) await lib.track(p.business_id, 'product_view', p.id);
    const others = (await Q.searchProducts({ businessId: p.business_id, limit: 9 })).filter((x) => x.id !== p.id).slice(0, 8);
    res.render('product', { title: `${p.name} · ${p.business_name}`, description: lib.clip(p.description, 155), p, others, ogImage: p.photo });
  });

  // ---------- Promociones ----------
  r.get('/promociones', async (req, res) => {
    res.render('promotions', { title: 'Promociones del día', promos: await Q.activePromotions({ limit: 200 }) });
  });

  // ---------- Derivaciones (cuenta clics y redirige) ----------
  r.get('/go/:type/:bizId', async (req, res, next) => {
    const bizId = lib.toInt(req.params.bizId);
    const biz = bizId && await db.get('SELECT * FROM businesses WHERE id = ?', bizId);
    if (!biz) return next();
    const pid = lib.toInt(req.query.p), rid = lib.toInt(req.query.r);
    const product = pid ? await db.get('SELECT * FROM products WHERE id = ? AND business_id = ?', pid, biz.id) : null;
    const proposal = rid ? await db.get('SELECT * FROM proposals WHERE id = ? AND business_id = ?', rid, biz.id) : null;
    let url = '', type = req.params.type;
    const base = res.locals.baseUrl;
    switch (type) {
      case 'whatsapp': {
        let text = `Hola ${biz.name}! Te encontré en Pulso Luján.`;
        if (product) text = `Hola ${biz.name}! Vi en Pulso Luján "${product.name}"${product.price ? ` a ${lib.fmtPrice(product.price)}` : ''}. ¿Está disponible? ${base}/p/${product.id}`;
        if (proposal) {
          const rq = await db.get('SELECT description FROM requests WHERE id = ?', proposal.request_id);
          text = `Hola ${biz.name}! Vi tu propuesta en BUSCO YA de Pulso Luján para "${lib.clip(rq && rq.description, 120)}"${proposal.price ? ` (${lib.fmtPrice(proposal.price)})` : ''}. Me interesa.`;
          type = 'proposal_whatsapp';
        }
        url = lib.waLink(biz.whatsapp || biz.phone, text);
        break;
      }
      case 'phone': url = biz.phone ? `tel:${biz.phone.replace(/[^\d+]/g, '')}` : ''; break;
      case 'web': url = lib.safeUrl(biz.website); break;
      case 'map': url = lib.mapsLink(biz); break;
      case 'instagram': url = lib.igUrl(biz.instagram); break;
      case 'facebook': url = lib.safeUrl(biz.facebook); break;
      default: return next();
    }
    if (!url) return res.redirect(`/c/${biz.slug}`);
    const isOwner = req.user && req.user.id === biz.owner_id;
    if (!isOwner) await lib.track(biz.id, 'click_' + type, product && product.id);
    res.redirect(302, url);
  });

  // ---------- Reportar datos incorrectos ----------
  r.post('/reportar', async (req, res) => {
    if (!lib.rateLimit('report:' + req.ip, 5, 3600_000) || req.body.website_hp) return res.redirect(req.get('Referrer') || '/');
    const bizId = lib.toInt(req.body.business_id);
    const biz = bizId && await db.get('SELECT slug FROM businesses WHERE id = ?', bizId);
    if (!biz) return res.redirect('/');
    await db.run('INSERT INTO reports (business_id, product_id, reason, details) VALUES (?, ?, ?, ?)',
      bizId, lib.toInt(req.body.product_id), lib.clip(req.body.reason, 60) || 'Otro', lib.clip(req.body.details, 600));
    req.flash('ok', 'Gracias por avisar. Vamos a revisar la información.');
    res.redirect(req.body.product_id ? `/p/${lib.toInt(req.body.product_id)}` : `/c/${biz.slug}`);
  });

  // ---------- BUSCO YA ----------
  async function myRequests(req) {
    const out = [];
    for (const t of req.session.myRequests || []) {
      const r = await db.get(`SELECT r.token, r.description, r.status, r.created_at,
        (SELECT COUNT(*) FROM proposals p WHERE p.request_id = r.id) AS proposals FROM requests r WHERE token = ?`, t);
      if (r) out.push(r);
    }
    return out;
  }
  r.get('/busco-ya', async (req, res) => {
    const recent = await db.all(`SELECT r.id, r.description, r.zone, r.budget, r.created_at, c.name AS category_name, c.icon AS category_icon,
        (SELECT COUNT(*) FROM proposals p WHERE p.request_id = r.id) AS proposals
      FROM requests r LEFT JOIN categories c ON c.id = r.category_id
      WHERE r.status IN ('open','closed') ORDER BY r.created_at DESC LIMIT 6`);
    res.render('busco-ya', { title: 'BUSCO YA: publicá lo que necesitás', recent, mine: await myRequests(req), form: {}, error: null, zones: await Q.zones() });
  });

  r.post('/busco-ya', upload.single('photo'), checkCsrf, async (req, res) => {
    const b = req.body;
    const s = req.settings;
    const fail = async (error) => res.status(400).render('busco-ya', { title: 'BUSCO YA', recent: [], mine: [], form: b, error, zones: await Q.zones() });
    if (b.website_hp) return res.redirect('/busco-ya'); // trampa anti-bots
    const name = lib.clip(b.name, 60), whatsapp = lib.normPhone(b.whatsapp);
    const description = lib.clip(b.description, 600);
    const catId = lib.toInt(b.category_id);
    const cat = catId && await db.get('SELECT * FROM categories WHERE id = ?', catId);
    if (!name || !description || description.length < 8) return fail('Contanos qué buscás con un poco más de detalle.');
    if (!cat) return fail('Elegí el rubro de lo que buscás.');
    if (!whatsapp || whatsapp.length < 12) return fail('Ingresá un WhatsApp válido (con código de área).');
    if (!b.acepto) return fail('Tenés que aceptar los términos para publicar.');
    const perDay = Number(s.requests_per_day) || 3;
    const recentCount = (await db.get('SELECT COUNT(*) n FROM requests WHERE (whatsapp = ? OR ip = ?) AND created_at > ?', whatsapp, req.ip, lib.sqlDaysAgo(1))).n;
    if (recentCount >= perDay) return fail(`Para evitar spam, se pueden publicar hasta ${perDay} pedidos por día. Probá mañana.`);
    const photo = req.file ? await lib.saveImage(req.file, { width: 1000, height: 1000 }) : '';
    const tk = lib.token(12);
    const days = Math.min(Math.max(Number(b.days) || Number(s.request_days) || 7, 1), 15);
    const id = await db.insert(`INSERT INTO requests (token, name, whatsapp, category_id, description, budget, zone, deadline, photo, ip, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, tk, name, whatsapp, cat.id, description, lib.toInt(b.budget),
    lib.clip(b.zone, 40), lib.clip(b.deadline, 60), photo, req.ip || '', lib.sqlPlusDays(days));
    for (const biz of await Q.matchingBusinessesForRequest({ category_id: cat.id })) await lib.track(biz.id, 'request_received');
    req.session.myRequests = [tk, ...(req.session.myRequests || [])].slice(0, 20);
    req.flash('ok', '¡Listo! Tu pedido fue enviado a los comercios del rubro. Guardá este enlace para ver las propuestas.');
    res.redirect(`/busco-ya/p/${tk}?nuevo=${id}`);
  });

  r.get('/busco-ya/p/:token', async (req, res, next) => {
    const rq = await db.get(`SELECT r.*, c.name AS category_name, c.icon AS category_icon FROM requests r
      LEFT JOIN categories c ON c.id = r.category_id WHERE r.token = ?`, req.params.token);
    if (!rq || rq.status === 'hidden') return next();
    const proposals = await db.all(`SELECT p.*, b.name AS business_name, b.slug AS business_slug, b.logo, b.zone, b.address, b.hours_json
      FROM proposals p JOIN businesses b ON b.id = p.business_id WHERE p.request_id = ? AND b.status = 'approved'
      ORDER BY p.price IS NULL, p.price ASC`, rq.id);
    proposals.forEach((p) => { p.open = lib.isOpenNow(p.hours_json); });
    const reached = (await Q.matchingBusinessesForRequest(rq)).length;
    const expired = rq.expires_at < lib.sqlNow();
    res.render('request-view', { title: 'Tu pedido BUSCO YA', rq, proposals, reached, expired, noindex: true });
  });

  r.post('/busco-ya/p/:token/estado', async (req, res, next) => {
    const rq = await db.get('SELECT * FROM requests WHERE token = ?', req.params.token);
    if (!rq) return next();
    const status = req.body.accion === 'reabrir' ? 'open' : 'closed';
    const expires = status === 'open' && rq.expires_at < lib.sqlNow() ? lib.sqlPlusDays(3) : rq.expires_at;
    await db.run('UPDATE requests SET status = ?, expires_at = ? WHERE id = ?', status, expires, rq.id);
    req.flash('ok', status === 'closed' ? 'Cerraste el pedido. Los comercios ya no podrán enviar propuestas.' : 'Pedido reabierto.');
    res.redirect(`/busco-ya/p/${rq.token}`);
  });

  // ---------- Para comercios ----------
  r.get('/comercios', (req, res) => {
    res.render('for-business', { title: 'Sumá tu comercio a Pulso Luján', description: 'Creá la ficha de tu negocio, publicá tus productos y recibí pedidos de vecinos de Luján.', sent: req.query.enviado === '1' });
  });
  r.post('/comercios/contacto', async (req, res) => {
    if (req.body.website_hp || !lib.rateLimit('lead:' + req.ip, 5, 3600_000)) return res.redirect('/comercios');
    const name = lib.clip(req.body.name, 80);
    if (name) {
      await db.run('INSERT INTO leads (name, business, whatsapp, message) VALUES (?, ?, ?, ?)',
        name, lib.clip(req.body.business, 80), lib.clip(req.body.whatsapp, 30), lib.clip(req.body.message, 600));
    }
    res.redirect('/comercios?enviado=1#contacto');
  });

  // ---------- QR ----------
  r.get('/qr/:slug.svg', async (req, res, next) => {
    const biz = await db.get('SELECT slug FROM businesses WHERE slug = ?', req.params.slug);
    if (!biz) return next();
    const svg = await QRCode.toString(`${res.locals.baseUrl}/c/${biz.slug}?utm_source=qr`, { type: 'svg', margin: 1, color: { dark: '#13263a', light: '#ffffff' } });
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
  });
  r.get('/qr-general.svg', async (req, res) => {
    const svg = await QRCode.toString(`${res.locals.baseUrl}/?utm_source=qr`, { type: 'svg', margin: 1, color: { dark: '#13263a', light: '#ffffff' } });
    res.type('image/svg+xml').send(svg);
  });

  // ---------- Páginas estáticas ----------
  r.get('/terminos', (req, res) => res.render('legal-terms', { title: 'Términos y condiciones' }));
  r.get('/privacidad', (req, res) => res.render('legal-privacy', { title: 'Política de privacidad' }));
  r.get('/como-funciona', (req, res) => res.render('how', { title: 'Cómo funciona Pulso' }));
  r.get('/offline', (req, res) => res.render('offline', { title: 'Sin conexión' }));

  r.get('/robots.txt', (req, res) => res.type('text/plain').send(`User-agent: *\nDisallow: /panel\nDisallow: /admin\nDisallow: /busco-ya/p/\nDisallow: /go/\nSitemap: ${res.locals.baseUrl}/sitemap.xml\n`));
  r.get('/sitemap.xml', async (req, res) => {
    const base = res.locals.baseUrl;
    const urls = ['/', '/buscar', '/promociones', '/busco-ya', '/comercios', '/como-funciona'];
    (await db.all("SELECT slug FROM businesses WHERE status = 'approved'")).forEach((b) => urls.push(`/c/${b.slug}`));
    (await db.all("SELECT p.id FROM products p JOIN businesses b ON b.id = p.business_id WHERE b.status = 'approved' AND p.active = 1")).forEach((p) => urls.push(`/p/${p.id}`));
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${base}${u}</loc></url>`).join('')}</urlset>`);
  });

  return r;
};
