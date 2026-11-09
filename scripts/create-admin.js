// Uso: npm run create-admin -- email@dominio.com "contraseña" ["Nombre"]
// Usa DATABASE_URL si está definida (Neon); si no, la base local.
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');

(async () => {
  const [email, password, name = 'Administrador'] = process.argv.slice(2);
  if (!email || !password || password.length < 8) {
    console.error('Uso: npm run create-admin -- email@dominio.com "contraseña-de-8+" ["Nombre"]');
    process.exit(1);
  }
  const hash = bcrypt.hashSync(password, 10);
  const existing = await db.get('SELECT id FROM users WHERE email = ?', email.toLowerCase());
  if (existing) {
    await db.run("UPDATE users SET password_hash = ?, role = 'admin', name = ? WHERE id = ?", hash, name, existing.id);
    console.log(`Usuario ${email} actualizado como administrador.`);
  } else {
    await db.run("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'admin')", email.toLowerCase(), hash, name);
    console.log(`Administrador ${email} creado.`);
  }
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
