const path = require('path');
const express = require('express');
const session = require('express-session');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { db, getSettings } = require('./db');
const lib = require('./lib');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(config.ROOT, 'views'));
app.set('trust proxy', 1);
app.disable('x-powered-by');

if (config.IS_PROD && config.SESSION_SECRET === 'cambiar-este-secreto-en-produccion') {
  console.error('Falta configurar SESSION_SECRET en producción.');
}

// Cabeceras de seguridad básicas
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// Archivos estáticos (en Vercel los sirve la CDN directamente desde /public)
app.use('/uploads', express.static(config.UPLOAD_DIR, { maxAge: '30d', immutable: true }));
app.use(express.static(path.join(config.ROOT, 'public'), { maxAge: config.IS_PROD ? '1d' : 0 }));
app.use(express.urlencoded({ extended: false, limit: '200kb' }));

// Base lista + primer administrador desde variables de entorno (ADMIN_EMAIL / ADMIN_PASSWORD)
let adminChecked = false;
app.use(async (req, res, next) => {
  await db.ready();
  if (!adminChecked) {
    adminChecked = true;
    const { ADMIN_EMAIL: email, ADMIN_PASSWORD: pass } = process.env;
    if (email && pass && pass.length >= 8 && !(await db.get("SELECT id FROM users WHERE role = 'admin'"))) {
      await db.run("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, 'Administrador', 'admin') ON CONFLICT (email) DO UPDATE SET role = 'admin'",
        email.toLowerCase(), bcrypt.hashSync(pass, 10));
      console.log(`Administrador ${email} creado.`);
    }
  }
  next();
});

app.use(session({
  store: new lib.DbStore(),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  name: 'pulso.sid',
  cookie: { httpOnly: true, sameSite: 'lax', secure: config.IS_PROD, maxAge: 30 * 86400000 },
}));

// Usuario actual, CSRF y helpers para las vistas
app.use(async (req, res, next) => {
  if (req.session.userId) {
    req.user = await db.get('SELECT id, email, name, role FROM users WHERE id = ?', req.session.userId);
    if (!req.user) delete req.session.userId;
  }
  if (req.user && req.user.role === 'merchant') {
    req.business = await db.get('SELECT * FROM businesses WHERE owner_id = ?', req.user.id);
  }
  if (!req.session.csrf) req.session.csrf = lib.token(18);
  req.settings = await getSettings();
  const baseUrl = config.BASE_URL || `${req.protocol}://${req.get('host')}`;
  Object.assign(res.locals, lib, {
    user: req.user || null,
    myBusiness: req.business || null,
    csrf: req.session.csrf,
    settings: req.settings,
    siteName: config.SITE_NAME,
    path: req.path,
    query: req.query,
    flash: req.session.flash || null,
    categories: await db.all('SELECT * FROM categories ORDER BY sort, id'),
    baseUrl,
    abs: (u) => lib.absUrl(baseUrl, u),
    title: '',
    description: '',
  });
  if (req.session.flash) delete req.session.flash;
  req.flash = (type, msg) => { req.session.flash = { type, msg }; };
  next();
});

// CSRF: formularios normales se validan acá; los multipart después de multer.
function checkCsrf(req, res, next) {
  if (req.method !== 'POST') return next();
  if (req.body && req.body._csrf && req.body._csrf === req.session.csrf) return next();
  res.status(403).render('error', { title: 'Sesión vencida', message: 'El formulario venció. Volvé atrás, recargá la página e intentá de nuevo.' });
}
app.use((req, res, next) => {
  if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('multipart/')) return checkCsrf(req, res, next);
  next();
});

// Vercel acepta como máximo 4,5 MB por pedido: el navegador achica las fotos antes de enviarlas.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024, files: 8 },
  fileFilter: (req, file, cb) => cb(null, /^image\/(jpe?g|png|webp|gif|heic|heif|avif)$/i.test(file.mimetype)),
});

app.use(require('./routes/public')(upload, checkCsrf));
app.use(require('./routes/auth')());
app.use('/panel', require('./routes/merchant')(upload, checkCsrf));
app.use('/admin', require('./routes/admin')());

app.use((req, res) => res.status(404).render('error', { title: 'No encontrado', message: 'La página que buscás no existe o fue retirada.' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  const big = err.code === 'LIMIT_FILE_SIZE';
  const msg = big ? 'La imagen es muy pesada (máximo 4 MB). Probá con una foto más chica.' : 'Ocurrió un error inesperado. Probá de nuevo en unos minutos.';
  if (!res.locals.settings) res.locals = { ...res.locals, ...lib, settings: {}, categories: [], user: null, csrf: '', flash: null, path: req.path, query: {}, siteName: config.SITE_NAME, baseUrl: '', title: '', description: '' };
  res.status(big ? 400 : 500).render('error', { title: 'Error', message: msg });
});

if (require.main === module) {
  app.listen(config.PORT, () => console.log(`${config.SITE_NAME} escuchando en http://localhost:${config.PORT}`));
}
module.exports = app;
