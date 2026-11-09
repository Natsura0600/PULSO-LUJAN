const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');
const lib = require('../lib');

module.exports = function authRoutes() {
  const r = express.Router();

  r.get('/registro', (req, res) => {
    if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/panel');
    res.render('register', { title: 'Registrá tu comercio', form: {}, error: null });
  });

  r.post('/registro', async (req, res) => {
    const b = req.body;
    const form = { ...b, password: '' };
    const fail = (error) => res.status(400).render('register', { title: 'Registrá tu comercio', form, error });
    if (b.website_hp) return res.redirect('/');
    if (!lib.rateLimit('reg:' + req.ip, 5, 3600_000)) return fail('Demasiados intentos. Probá más tarde.');
    const email = lib.clip(b.email, 120).toLowerCase();
    const name = lib.clip(b.name, 80), bizName = lib.clip(b.business_name, 80);
    const catId = lib.toInt(b.category_id);
    const cat = catId && await db.get('SELECT id FROM categories WHERE id = ?', catId);
    if (!name || !bizName) return fail('Completá tu nombre y el nombre del comercio.');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Ingresá un email válido.');
    if (!b.password || b.password.length < 8) return fail('La contraseña debe tener al menos 8 caracteres.');
    if (!cat) return fail('Elegí el rubro principal.');
    if (!lib.normPhone(b.whatsapp)) return fail('Ingresá el WhatsApp del comercio.');
    if (!b.acepto) return fail('Tenés que aceptar los términos y condiciones.');
    if (await db.get('SELECT id FROM users WHERE email = ?', email)) return fail('Ya existe una cuenta con ese email. Ingresá desde “Ingresar”.');
    const hash = bcrypt.hashSync(b.password, 10);
    const slug = await lib.uniqueSlug(bizName);
    const uid = await db.tx(async (t) => {
      const id = await t.insert("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'merchant')", email, hash, name);
      await t.run(`INSERT INTO businesses (owner_id, slug, name, category_id, whatsapp, phone, address, zone, plan, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pro', 'pending')`, id, slug, bizName, cat.id,
      lib.clip(b.whatsapp, 30), lib.clip(b.whatsapp, 30), lib.clip(b.address, 120), lib.clip(b.zone, 40));
      return id;
    });
    req.session.regenerate(() => {
      req.session.userId = uid;
      req.session.flash = { type: 'ok', msg: '¡Bienvenido/a a Pulso! Completá tu ficha y cargá tus productos. Cuando la revisemos, tu comercio quedará publicado.' };
      req.session.save(() => res.redirect('/panel/ficha'));
    });
  });

  r.get('/ingresar', (req, res) => {
    if (req.user) return res.redirect(req.user.role === 'admin' ? '/admin' : '/panel');
    res.render('login', { title: 'Ingresar', error: null, email: '', next: lib.clip(req.query.next, 200) });
  });

  r.post('/ingresar', async (req, res) => {
    const email = lib.clip(req.body.email, 120).toLowerCase();
    const nextUrl = String(req.body.next || '');
    const fail = (error) => res.status(400).render('login', { title: 'Ingresar', error, email, next: nextUrl });
    if (!lib.rateLimit('login:' + req.ip, 10, 15 * 60_000)) return fail('Demasiados intentos. Esperá unos minutos.');
    const u = await db.get('SELECT * FROM users WHERE email = ?', email);
    if (!u || !bcrypt.compareSync(String(req.body.password || ''), u.password_hash)) return fail('Email o contraseña incorrectos.');
    req.session.regenerate(() => {
      req.session.userId = u.id;
      const dest = nextUrl.startsWith('/') && !nextUrl.startsWith('//') ? nextUrl : (u.role === 'admin' ? '/admin' : '/panel');
      req.session.save(() => res.redirect(dest));
    });
  });

  r.post('/salir', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  return r;
};
