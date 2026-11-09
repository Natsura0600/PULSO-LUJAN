// Prueba de punta a punta del flujo principal: comercio, admin, vecino y BUSCO YA.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pulso-test-'));
process.env.PGLITE_MEMORY = '1';
delete process.env.DATABASE_URL;
const app = require('../src/server');
const { db } = require('../src/db');
const bcrypt = require('bcryptjs');

let server, base;
test.before(async () => {
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  await db.run("INSERT INTO users (email, password_hash, name, role) VALUES ('admin@t.test', ?, 'Admin', 'admin')", bcrypt.hashSync('admin12345', 4));
});
test.after(() => server.close());

function client() {
  let cookie = '';
  async function req(method, url, body, isForm) {
    const headers = { cookie };
    let payload;
    if (body && !isForm) { headers['content-type'] = 'application/x-www-form-urlencoded'; payload = new URLSearchParams(body).toString(); }
    if (isForm) payload = body;
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie();
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    return { status: res.status, location: res.headers.get('location'), text: await res.text() };
  }
  async function csrf(url) {
    const r = await req('GET', url);
    const m = r.text.match(/name="_csrf" value="([^"]+)"/);
    return m && m[1];
  }
  return { req, csrf };
}
const png = () => new Blob([fs.readFileSync(path.join(__dirname, '..', 'public', 'icons', 'icon-192.png'))], { type: 'image/png' });

test('flujo completo', async () => {
  const shop = client(), admin = client(), vecino = client();

  // 1) Comercio se registra
  let t = await shop.csrf('/registro');
  let r = await shop.req('POST', '/registro', { _csrf: t, business_name: 'Zapatería Test', category_id: (await db.get("SELECT id FROM categories WHERE slug='calzado'")).id,
    whatsapp: '2323 555555', name: 'Ana', email: 'ana@t.test', password: 'clave12345', acepto: '1' });
  assert.equal(r.status, 302); assert.equal(r.location, '/panel/ficha');
  const biz = (await db.get("SELECT * FROM businesses WHERE name = 'Zapatería Test'"));
  assert.equal(biz.status, 'pending');

  // CSRF inválido rechazado
  r = await shop.req('POST', '/panel/productos/x/borrar', { _csrf: 'malo' });
  assert.equal(r.status, 403);

  // 2) Carga ficha con horarios y un producto con foto
  t = await shop.csrf('/panel/ficha');
  const fd = new FormData();
  Object.entries({ _csrf: t, name: 'Zapatería Test', category_id: String(biz.category_id), description: 'Calzado para toda la familia en Luján.', address: 'San Martín 100',
    zone: 'Centro', whatsapp: '2323 555555', delivery: 'ambos' }).forEach(([k, v]) => fd.append(k, v));
  for (let d = 0; d < 7; d++) { fd.append(`h${d}_a_open`, '00:00'); fd.append(`h${d}_a_close`, '23:59'); }
  fd.append('logo', png(), 'logo.png');
  r = await shop.req('POST', '/panel/ficha', fd, true);
  assert.equal(r.status, 302);
  assert.ok((await db.get('SELECT logo FROM businesses WHERE id = ?', biz.id)).logo.startsWith('/uploads/'));
  assert.ok(fs.existsSync(path.join(process.env.DATA_DIR, 'uploads', path.basename((await db.get('SELECT logo FROM businesses WHERE id = ?', biz.id)).logo).replace('-o.webp', '-t.webp'))));

  t = await shop.csrf('/panel/productos/nuevo');
  const pf = new FormData();
  Object.entries({ _csrf: t, name: 'Zapatillas running 42', description: 'Livianas', price: '$ 95.000', availability: 'disponible', active: '1' }).forEach(([k, v]) => pf.append(k, v));
  pf.append('photo', png(), 'p.png');
  r = await shop.req('POST', '/panel/productos/nuevo', pf, true);
  assert.equal(r.status, 302);
  const prod = (await db.get('SELECT * FROM products WHERE business_id = ?', biz.id));
  assert.equal(prod.price, 95000);

  // No es público hasta aprobarse
  r = await vecino.req('GET', `/c/${biz.slug}`);
  assert.equal(r.status, 404);

  // 3) Admin aprueba → arranca prueba Pro
  t = await admin.csrf('/ingresar');
  r = await admin.req('POST', '/ingresar', { _csrf: t, email: 'admin@t.test', password: 'admin12345' });
  assert.equal(r.location, '/admin');
  t = await admin.csrf(`/admin/comercios/${biz.id}`);
  r = await admin.req('POST', `/admin/comercios/${biz.id}/estado`, { _csrf: t, status: 'approved' });
  const approved = (await db.get('SELECT * FROM businesses WHERE id = ?', biz.id));
  assert.equal(approved.status, 'approved'); assert.equal(approved.plan, 'pro'); assert.ok(approved.plan_until);

  // 4) Vecino busca y encuentra
  r = await vecino.req('GET', '/buscar?q=zapatilla');
  assert.match(r.text, /Zapatillas running 42/);
  r = await vecino.req('GET', '/buscar?q=ZAPATERIA&abierto=1&tipo=comercios');
  assert.match(r.text, /Zapatería Test/);
  r = await vecino.req('GET', `/c/${biz.slug}`);
  assert.equal(r.status, 200);
  r = await vecino.req('GET', `/go/whatsapp/${biz.id}?p=${prod.id}`);
  assert.equal(r.status, 302); assert.match(r.location, /^https:\/\/wa\.me\/5492323555555\?text=/);

  // 5) BUSCO YA
  t = await vecino.csrf('/busco-ya');
  const bf = new FormData();
  Object.entries({ _csrf: t, description: 'Busco zapatillas talle 42 para hoy', category_id: String(biz.category_id), budget: '100000', name: 'Juan', whatsapp: '2323 444444', acepto: '1' }).forEach(([k, v]) => bf.append(k, v));
  r = await vecino.req('POST', '/busco-ya', bf, true);
  assert.equal(r.status, 302);
  const reqUrl = r.location.split('?')[0];
  const rq = (await db.get('SELECT * FROM requests ORDER BY id DESC'));

  // Comercio ve el pedido y responde
  r = await shop.req('GET', '/panel/pedidos');
  assert.match(r.text, /Busco zapatillas talle 42/);
  assert.doesNotMatch(r.text, /444444/); // el teléfono del vecino no se expone
  t = await shop.csrf('/panel/pedidos');
  const rf = new FormData();
  Object.entries({ _csrf: t, message: 'Tengo las running 42', price: '90000', availability: 'disponible', delivery: 'retiro', product_id: String(prod.id) }).forEach(([k, v]) => rf.append(k, v));
  r = await shop.req('POST', `/panel/pedidos/${rq.id}/responder`, rf, true);
  assert.equal(r.status, 302);

  // Vecino ve la propuesta
  r = await vecino.req('GET', reqUrl);
  assert.match(r.text, /Tengo las running 42/);
  const prop = (await db.get('SELECT id FROM proposals WHERE request_id = ?', rq.id));
  r = await vecino.req('GET', `/go/whatsapp/${biz.id}?r=${prop.id}`);
  assert.match(r.location, /wa\.me/);

  // 6) Promoción y canje
  t = await shop.csrf('/panel/promociones');
  const today = new Date().toISOString().slice(0, 10);
  const prf = new FormData();
  Object.entries({ _csrf: t, title: '10% off', conditions: 'Efectivo', starts_at: '2000-01-01', ends_at: '2999-01-01', code: 'TEST10' }).forEach(([k, v]) => prf.append(k, v));
  r = await shop.req('POST', '/panel/promociones', prf, true);
  assert.equal(r.status, 302);
  t = await shop.csrf('/panel/promociones');
  await shop.req('POST', '/panel/canje', { _csrf: t, code: 'test10' });
  assert.equal((await db.get('SELECT COUNT(*) n FROM redemptions')).n, 1);
  r = await vecino.req('GET', '/promociones');
  assert.match(r.text, /10% off/);
  assert.ok(today);

  // 7) Métricas del panel
  r = await shop.req('GET', '/panel');
  assert.equal(r.status, 200);
  assert.match(r.text, /Clics a WhatsApp/);

  // 8) Admin registra pago Destacado
  t = await admin.csrf(`/admin/comercios/${biz.id}`);
  await admin.req('POST', `/admin/comercios/${biz.id}/pago`, { _csrf: t, plan: 'destacado', months: '2', method: 'Transferencia' });
  const paid = (await db.get('SELECT * FROM businesses WHERE id = ?', biz.id));
  assert.equal(paid.plan, 'destacado');
  r = await vecino.req('GET', '/');
  assert.match(r.text, /Patrocinado/);
  r = await admin.req('GET', '/admin');
  assert.equal(r.status, 200);
  for (const p of ['/admin/comercios', '/admin/pedidos', '/admin/reportes', '/admin/contactos', '/admin/ajustes']) {
    assert.equal((await admin.req('GET', p)).status, 200, p);
  }
  for (const p of ['/panel/ficha', '/panel/productos', `/panel/productos/${prod.id}`, '/panel/plan', '/panel/qr', '/panel/cuenta']) {
    assert.equal((await shop.req('GET', p)).status, 200, p);
  }

  for (const p of ['/panel/promociones', '/panel/pedidos', '/panel/productos/nuevo']) {
    assert.equal((await shop.req('GET', p)).status, 200, p);
  }
  for (const p of ['/', '/buscar', '/promociones', '/busco-ya', '/comercios', '/como-funciona', '/terminos', '/privacidad', '/ingresar', '/registro', '/offline', `/p/${prod.id}`, '/buscar?q=zzzz-nada', reqUrl]) {
    assert.equal((await vecino.req('GET', p)).status, 200, p);
  }
  assert.equal((await vecino.req('GET', '/no-existe')).status, 404);

  // Precio rápido desde la lista de productos
  t = await shop.csrf('/panel/productos');
  r = await shop.req('POST', `/panel/productos/${prod.id}/precio`, { _csrf: t, price: '$ 99.500' });
  assert.equal(r.status, 302);
  assert.equal((await db.get('SELECT price FROM products WHERE id = ?', prod.id)).price, 99500);
  r = await shop.req('POST', `/panel/productos/${prod.id}/precio`, { _csrf: t, price: '' });
  assert.equal((await db.get('SELECT price FROM products WHERE id = ?', prod.id)).price, null);

  // 9) Un comerciante no puede entrar al admin
  r = await shop.req('GET', '/admin');
  assert.equal(r.status, 403);
});

test('respaldo: solo el admin puede descargarlo', async () => {
  const anon = client();
  assert.equal((await anon.req('GET', '/admin/respaldo')).status, 302);
  const admin = client();
  const t = await admin.csrf('/ingresar');
  await admin.req('POST', '/ingresar', { _csrf: t, email: 'admin@t.test', password: 'admin12345' });
  const r = await admin.req('GET', '/admin/respaldo');
  assert.equal(r.status, 200);
});

test('superadmin: crear, ordenar y borrar rubros (con reasignación)', async () => {
  const admin = client();
  let t = await admin.csrf('/ingresar');
  await admin.req('POST', '/ingresar', { _csrf: t, email: 'admin@t.test', password: 'admin12345' });
  let r = await admin.req('GET', '/admin/rubros');
  assert.equal(r.status, 200);
  assert.match(r.text, /Sí, borrar rubro/);

  t = await admin.csrf('/admin/rubros');
  r = await admin.req('POST', '/admin/categorias', { _csrf: t, name: 'Florería', icon: '💐' });
  assert.equal(r.status, 302);
  const flor = await db.get("SELECT * FROM categories WHERE name = 'Florería'");
  assert.ok(flor);

  // Renombrar y mover
  await admin.req('POST', `/admin/categorias/${flor.id}`, { _csrf: t, name: 'Florería Test', icon: '🌸' });
  assert.equal((await db.get('SELECT name FROM categories WHERE id = ?', flor.id)).name, 'Florería Test');
  const before = (await db.all('SELECT id FROM categories ORDER BY sort, id')).map((c) => c.id);
  await admin.req('POST', `/admin/categorias/${flor.id}/mover`, { _csrf: t, dir: 'up' });
  const after = (await db.all('SELECT id FROM categories ORDER BY sort, id')).map((c) => c.id);
  assert.notDeepEqual(before, after);

  // Un comercio y un pedido en el rubro nuevo
  const owner = await db.get("SELECT id FROM users WHERE email = 'ana@t.test'");
  const bizId = (await db.get('SELECT id FROM businesses WHERE owner_id = ?', owner.id)).id;
  const calzado = await db.get("SELECT id FROM categories WHERE slug = 'calzado'");
  await db.run('UPDATE businesses SET category_id = ? WHERE id = ?', flor.id, bizId);
  await db.run("INSERT INTO requests (category_id, description, name, whatsapp, token, expires_at) VALUES (?, 'Busco ramo de rosas', 'Lu', '5490000111', 'tok-test-flor', '2999-01-01')", flor.id);

  // Borrar moviendo todo a otro rubro
  r = await admin.req('POST', `/admin/categorias/${flor.id}/borrar`, { _csrf: t, move_to: String(calzado.id) });
  assert.equal(r.status, 302);
  assert.equal(await db.get('SELECT id FROM categories WHERE id = ?', flor.id), undefined);
  assert.equal((await db.get('SELECT category_id FROM businesses WHERE id = ?', bizId)).category_id, calzado.id);
  assert.equal((await db.get("SELECT category_id FROM requests WHERE token = 'tok-test-flor'")).category_id, calzado.id);

  // Borrar sin destino: queda "sin rubro" y las páginas siguen funcionando
  r = await admin.req('POST', `/admin/categorias/${calzado.id}/borrar`, { _csrf: t, move_to: '' });
  assert.equal(r.status, 302);
  assert.equal((await db.get('SELECT category_id FROM businesses WHERE id = ?', bizId)).category_id, null);
  const slug = (await db.get('SELECT slug FROM businesses WHERE id = ?', bizId)).slug;
  const vecino = client();
  for (const p of ['/', '/buscar', `/c/${slug}`, '/busco-ya']) assert.equal((await vecino.req('GET', p)).status, 200, p);
  const prodId = (await db.get('SELECT id FROM products WHERE business_id = ?', bizId)).id;
  assert.equal((await vecino.req('GET', `/p/${prodId}`)).status, 200);
  for (const p of ['/admin/rubros', '/admin/comercios', `/admin/comercios/${bizId}`]) assert.equal((await admin.req('GET', p)).status, 200, p);

  // Datos de demostración: cargar y borrar
  r = await admin.req('POST', '/admin/demo/cargar', { _csrf: t });
  assert.equal(r.status, 302);
  assert.ok((await db.get("SELECT COUNT(*)::int n FROM users WHERE email LIKE '%@demo.pulso'")).n > 5);
  assert.equal((await vecino.req('GET', '/')).status, 200);
  r = await admin.req('POST', '/admin/demo/borrar', { _csrf: t });
  assert.equal((await db.get("SELECT COUNT(*)::int n FROM users WHERE email LIKE '%@demo.pulso'")).n, 0);
});
