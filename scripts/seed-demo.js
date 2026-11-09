// Datos de demostración para probar el sitio. NO usar en producción con datos reales.
// npm run demo:seed   → crea comercios de ejemplo (emails @demo.pulso)
// npm run demo:clear  → borra todo lo creado por la demo
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');
const lib = require('../src/lib');

async function clear() {
  const users = await db.all("SELECT id FROM users WHERE email LIKE '%@demo.pulso'");
  for (const u of users) await db.run('DELETE FROM users WHERE id = ?', u.id);
  await db.run("DELETE FROM requests WHERE whatsapp LIKE '5490000%'");
  console.log(`Demo eliminada (${users.length} comercios).`);
}

const PALETTE = ['#0e9f84', '#24597a', '#d9a94a', '#c2412d', '#6b4fa3', '#1c3a55', '#2f855a', '#b7791f'];
async function img(label, emoji, w = 900, h = 900, i = 0) {
  const c1 = PALETTE[i % PALETTE.length], c2 = PALETTE[(i + 3) % PALETTE.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${w * 0.8}" cy="${h * 0.2}" r="${Math.min(w, h) * 0.35}" fill="#ffffff" opacity=".08"/>
    <text x="50%" y="52%" text-anchor="middle" font-family="Arial" font-weight="700" font-size="${Math.min(w, h) * 0.09}" fill="#fff">${label.replace(/&/g, '&amp;')}</text>
    <text x="50%" y="66%" text-anchor="middle" font-family="Arial" font-size="${Math.min(w, h) * 0.05}" fill="#ffffff" opacity=".8">${emoji}</text></svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return lib.saveImage({ buffer }, { width: w, height: h, thumb: w > 1000 ? 640 : 480 });
}

const H = (a, b, c, d) => (c ? [[a, b], [c, d]] : [[a, b]]);
const weekHours = (r, sat, sun) => ({ 1: r, 2: r, 3: r, 4: r, 5: r, 6: sat || [], 0: sun || [] });

const DEMO = [
  { name: 'Calzados San Martín', cat: 'calzado', zone: 'Centro', address: 'San Martín 450', plan: 'destacado',
    desc: 'Zapatillas, botas y calzado escolar de las mejores marcas. Más de 30 años en el centro de Luján.',
    hours: weekHours(H('09:00', '13:00', '16:30', '20:30'), H('09:30', '13:30', '17:00', '20:30')),
    products: [['Zapatillas running hombre', 95000, 'Talles 39 al 45. Suela de goma, ideal para correr y caminar.'], ['Zapatillas urbanas mujer', 78000, 'Cuero ecológico, varios colores.'], ['Botas de lluvia niños', 32000, 'Talles 24 al 34.'], ['Mocasines de cuero', 110000, 'Cuero vacuno, hechos en Argentina.']] },
  { name: 'Café de la Basílica', cat: 'cafeterias', zone: 'Basílica', address: 'Av. Nuestra Señora de Luján 120', plan: 'pro',
    desc: 'Café de especialidad, medialunas caseras y tortas del día frente a la Basílica.',
    hours: weekHours(H('07:30', '21:00'), H('08:00', '22:00'), H('08:00', '22:00')),
    products: [['Desayuno completo', 9500, 'Café con leche, 2 medialunas, jugo y tostadas.'], ['Torta de ricota', 4800, 'La porción. Receta de la abuela.'], ['Café de especialidad', 3500, 'Etiopía o Colombia, en filtrado o espresso.']] },
  { name: 'Moda Luján', cat: 'ropa', zone: 'Centro', address: 'Colón 233', plan: 'pro',
    desc: 'Ropa de mujer y hombre. Temporada primavera-verano 2026 ya disponible.',
    hours: weekHours(H('09:30', '13:00', '16:30', '20:00'), H('10:00', '13:30')),
    products: [['Camperas rompevientos', 54000, 'Impermeables, talles S a XXL.'], ['Jeans mom fit', 42000, 'Tiro alto, talles 36 al 46.'], ['Remeras básicas algodón', 12000, 'Pack de colores lisos.']] },
  { name: 'Ferretería El Tornillo', cat: 'ferreteria', zone: 'San Fermín', address: 'Mitre 980', plan: 'pro',
    desc: 'Todo para la construcción, pinturería y herramientas. Envíos en Luján.',
    hours: weekHours(H('08:00', '12:30', '15:30', '19:30'), H('08:00', '13:00')),
    products: [['Taladro percutor 650W', 68000, 'Incluye maletín y set de mechas.'], ['Látex interior 20 L', 89000, 'Blanco mate, alto rendimiento.']] },
  { name: 'Peluquería Estilo', cat: 'belleza', zone: 'Centro', address: 'Lavalle 410', plan: 'basico',
    desc: 'Cortes, color y tratamientos. Atención con turno por WhatsApp.',
    hours: weekHours(H('10:00', '20:00'), H('09:00', '14:00')),
    products: [['Corte y peinado', 15000, 'Mujer o hombre.'], ['Coloración completa', 38000, 'Incluye tratamiento.']] },
  { name: 'Pizzería Don Luis', cat: 'gastronomia', zone: 'El Quinto', address: 'Constitución 1500', plan: 'destacado',
    desc: 'Pizzas a la piedra y empanadas al horno de barro. Delivery en todo Luján.',
    hours: weekHours(H('19:00', '00:30'), H('19:00', '01:00'), H('19:00', '00:30')),
    products: [['Pizza muzzarella grande', 14500, '8 porciones, a la piedra.'], ['Docena de empanadas', 21000, 'Carne cortada a cuchillo, pollo o jamón y queso.'], ['Fainá', 3500, 'La porción.']] },
];

(async () => {
  if (process.argv.includes('--clear')) { await clear(); process.exit(0); }
  const hash = bcrypt.hashSync('demo12345', 10);
  let i = 0;
  for (const d of DEMO) {
    const email = lib.slugify(d.name).replace(/-/g, '') + '@demo.pulso';
    if (await db.get('SELECT id FROM users WHERE email = ?', email)) continue;
    const cat = await db.get('SELECT id FROM categories WHERE slug = ?', d.cat);
    const uid = await db.insert("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'merchant')", email, hash, 'Demo');
    const cover = await img(d.name, '', 1600, 700, i);
    const logo = await img(d.name.split(' ').map((w) => w[0]).join('').slice(0, 2), '', 400, 400, i + 1);
    const until = d.plan === 'basico' ? null : lib.sqlPlusDays(30);
    const bid = await db.insert(`INSERT INTO businesses (owner_id, slug, name, category_id, description, address, zone, whatsapp, phone, hours_json, logo, cover, plan, plan_until, status, delivery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'ambos')`, uid, await lib.uniqueSlug(d.name), d.name, cat.id, d.desc, d.address, d.zone,
    '2323 400000', '2323 400000', JSON.stringify(d.hours), logo, cover, d.plan, until);
    let j = 0;
    for (const [name, price, desc] of d.products) {
      const photo = await img(name, '', 900, 900, i + j++);
      await db.run('INSERT INTO products (business_id, name, description, price, photo) VALUES (?, ?, ?, ?, ?)', bid, name, desc, price, photo);
    }
    if (d.plan !== 'basico') {
      await db.run('INSERT INTO promotions (business_id, title, description, conditions, starts_at, ends_at, code) VALUES (?, ?, ?, ?, ?, ?, ?)',
        bid, i % 2 ? '2x1 los martes' : '15% off pagando en efectivo', 'Exclusivo para clientes de Pulso.', 'Mostrando el código en el local. No acumulable con otras promociones.', lib.todayAR(), new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), 'PULSO' + (i + 1));
    }
    i++;
  }
  const cal = await db.get("SELECT id FROM categories WHERE slug = 'calzado'");
  if (!(await db.get("SELECT id FROM requests WHERE whatsapp LIKE '5490000%'"))) {
    await db.run('INSERT INTO requests (token, name, whatsapp, category_id, description, budget, zone, deadline, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      lib.token(12), 'Martina', '549000011111', cal.id, 'Busco zapatillas talle 42, hasta $100.000, para retirar hoy en Luján', 100000, 'Centro', 'Hoy', lib.sqlPlusDays(7));
  }
  console.log('Demo creada. Acceso a cualquier comercio demo: <nombre-sin-espacios>@demo.pulso / demo12345 (ej. calzadossanmartin@demo.pulso)');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
