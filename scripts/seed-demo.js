// Datos de demostración para mostrar el sitio funcionando (comercios, productos, promos y pedidos de ejemplo).
//   npm run demo:seed   → crea los comercios de ejemplo (emails @demo.pulso)
//   npm run demo:clear  → borra todo lo creado por la demo
// También se puede cargar/borrar desde Superadmin → Ajustes → Datos de demostración.
const sharp = require('sharp');
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');
const lib = require('../src/lib');

const PALETTE = [['#D2412A', '#F2B93B'], ['#1E6B57', '#DCEBE3'], ['#17130F', '#D2412A'], ['#F2B93B', '#1E6B57'], ['#3B5B7A', '#F4EEE2'], ['#8C2F1D', '#F2B93B'], ['#2F7F6B', '#F4EEE2'], ['#5A4636', '#F2B93B']];

// Imagen de muestra con la paleta de Pulso: fondo de color, patrón y una etiqueta.
async function img(label, w, h, i, opts = {}) {
  const [c1, c2] = PALETTE[i % PALETTE.length];
  const pattern = i % 3;
  const deco = pattern === 0
    ? `<circle cx="${w * 0.82}" cy="${h * 0.22}" r="${Math.min(w, h) * 0.34}" fill="${c2}" opacity=".9"/><circle cx="${w * 0.18}" cy="${h * 0.9}" r="${Math.min(w, h) * 0.22}" fill="#000" opacity=".12"/>`
    : pattern === 1
      ? Array.from({ length: 8 }, (_, k) => `<rect x="${(w / 8) * k}" y="0" width="${w / 16}" height="${h}" fill="${c2}" opacity=".16"/>`).join('')
      : `<rect x="${w * 0.52}" y="${h * 0.1}" width="${w * 0.4}" height="${w * 0.4}" rx="${w * 0.06}" fill="${c2}" transform="rotate(12 ${w * 0.72} ${h * 0.3})" opacity=".92"/>`;
  const fs = opts.small ? Math.min(w, h) * 0.075 : Math.min(w, h) * 0.1;
  const words = String(label).replace(/&/g, '&amp;').split(' ');
  const lines = [];
  let cur = '';
  for (const wd of words) { if ((cur + ' ' + wd).trim().length > (opts.max || 16)) { lines.push(cur.trim()); cur = wd; } else cur += ' ' + wd; }
  lines.push(cur.trim());
  const text = lines.slice(0, 3).map((ln, k) => `<text x="${w * 0.08}" y="${h * 0.62 + k * fs * 1.15}" font-family="DejaVu Sans, Arial, sans-serif" font-weight="800" font-size="${fs}" fill="${c1 === '#F2B93B' ? '#17130F' : '#F4EEE2'}">${ln}</text>`).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${c1}"/>${deco}${text}</svg>`;
  const buffer = await sharp(Buffer.from(svg)).png().toBuffer();
  return lib.saveImage({ buffer }, { width: w, height: h, thumb: w > 1000 ? 640 : 480 });
}

const H = (a, b, c, d) => (c ? [[a, b], [c, d]] : [[a, b]]);
const week = (r, sat, sun) => ({ 1: r, 2: r, 3: r, 4: r, 5: r, 6: sat || [], 0: sun || [] });

const DEMO = [
  { name: 'Calzados San Martín', cat: 'calzado', zone: 'Centro', address: 'San Martín 450', plan: 'destacado',
    desc: 'Zapatillas, botas y calzado escolar de las mejores marcas. Más de 30 años en el centro de Luján.',
    hours: week(H('09:00', '13:00', '16:30', '20:30'), H('09:30', '13:30', '17:00', '20:30')),
    products: [['Zapatillas running hombre', 95000, 'Talles 39 al 45. Suela de goma, ideal para correr y caminar.'], ['Zapatillas urbanas mujer', 78000, 'Cuero ecológico, varios colores.'], ['Botas de lluvia niños', 32000, 'Talles 24 al 34.'], ['Mocasines de cuero', 110000, 'Cuero vacuno, hechos en Argentina.']] },
  { name: 'Café de la Basílica', cat: 'cafeterias', zone: 'Basílica', address: 'Av. Nuestra Señora de Luján 120', plan: 'pro',
    desc: 'Café de especialidad, medialunas caseras y tortas del día frente a la Basílica.',
    hours: week(H('07:30', '21:00'), H('08:00', '22:00'), H('08:00', '22:00')),
    products: [['Desayuno completo', 9500, 'Café con leche, 2 medialunas, jugo y tostadas.'], ['Torta de ricota', 4800, 'La porción. Receta de la abuela.'], ['Café de especialidad', 3500, 'Etiopía o Colombia, en filtrado o espresso.']] },
  { name: 'Moda Luján', cat: 'ropa', zone: 'Centro', address: 'Colón 233', plan: 'pro',
    desc: 'Ropa de mujer y hombre. Temporada primavera-verano ya disponible.',
    hours: week(H('09:30', '13:00', '16:30', '20:00'), H('10:00', '13:30')),
    products: [['Camperas rompevientos', 54000, 'Impermeables, talles S a XXL.'], ['Jeans mom fit', 42000, 'Tiro alto, talles 36 al 46.'], ['Remeras básicas algodón', 12000, 'Pack de colores lisos.']] },
  { name: 'Ferretería El Tornillo', cat: 'ferreteria', zone: 'San Fermín', address: 'Mitre 980', plan: 'pro',
    desc: 'Todo para la construcción, pinturería y herramientas. Envíos en Luján.',
    hours: week(H('08:00', '12:30', '15:30', '19:30'), H('08:00', '13:00')),
    products: [['Taladro percutor 650W', 68000, 'Incluye maletín y set de mechas.'], ['Látex interior 20 L', 89000, 'Blanco mate, alto rendimiento.'], ['Set de destornilladores', 15500, '12 piezas con punta magnética.']] },
  { name: 'Peluquería Estilo', cat: 'belleza', zone: 'Centro', address: 'Lavalle 410', plan: 'basico',
    desc: 'Cortes, color y tratamientos. Atención con turno por WhatsApp.',
    hours: week(H('10:00', '20:00'), H('09:00', '14:00')),
    products: [['Corte y peinado', 15000, 'Mujer o hombre.'], ['Coloración completa', 38000, 'Incluye tratamiento.']] },
  { name: 'Pizzería Don Luis', cat: 'gastronomia', zone: 'El Quinto', address: 'Constitución 1500', plan: 'destacado',
    desc: 'Pizzas a la piedra y empanadas al horno de barro. Delivery en todo Luján.',
    hours: week(H('19:00', '00:30'), H('19:00', '01:00'), H('19:00', '00:30')),
    products: [['Pizza muzzarella grande', 14500, '8 porciones, a la piedra.'], ['Docena de empanadas', 21000, 'Carne cortada a cuchillo, pollo o jamón y queso.'], ['Fainá', 3500, 'La porción.']] },
  { name: 'Librería Gutenberg', cat: 'libreria', zone: 'Centro', address: 'Lezica y Torrezuri 560', plan: 'pro',
    desc: 'Útiles escolares, libros, regalos y fotocopias. Armamos tu lista de útiles.',
    hours: week(H('08:30', '12:30', '16:00', '20:00'), H('09:00', '13:00')),
    products: [['Mochila escolar reforzada', 36000, 'Varios diseños, 2 compartimentos.'], ['Pack de cuadernos x3', 9800, 'Tapa dura, 48 hojas.'], ['Set de geometría', 4200, 'Regla, escuadra, transportador y compás.']] },
  { name: 'Veterinaria Patitas', cat: 'mascotas', zone: 'Villa Flandria', address: 'Ruta 5 km 66', plan: 'basico',
    desc: 'Alimento balanceado, accesorios y consultas veterinarias. Turnos por WhatsApp.',
    hours: week(H('09:00', '13:00', '16:00', '20:00'), H('09:00', '13:00')),
    products: [['Alimento perro adulto 20 kg', 58000, 'Balanceado premium.'], ['Rascador para gatos', 24000, 'Torre de 3 niveles.']] },
  { name: 'Almacén Don Pedro', cat: 'almacen', zone: 'Barrio Parque', address: 'Moreno 1120', plan: 'basico',
    desc: 'Almacén de barrio con fiambres, lácteos y productos regionales.',
    hours: week(H('08:00', '13:00', '16:30', '21:00'), H('08:00', '14:00'), H('09:00', '13:00')),
    products: [['Queso cremoso', 9800, 'Por kilo.'], ['Pan casero', 2400, 'Horneado cada mañana.']] },
  { name: 'Luján Tech', cat: 'tecnologia', zone: 'Centro', address: 'San Martín 780', plan: 'pro',
    desc: 'Celulares, accesorios y servicio técnico. Cambio de pantallas en el día.',
    hours: week(H('09:30', '13:00', '16:30', '20:00'), H('10:00', '14:00')),
    products: [['Cambio de pantalla', 45000, 'Según modelo, consultar. Garantía de 3 meses.'], ['Cargador rápido 25W', 14500, 'Incluye cable USB-C.'], ['Funda reforzada', 7800, 'Para los modelos más vendidos.']] },
  { name: 'Hogar y Deco Rivera', cat: 'hogar', zone: 'Centro', address: 'Rivadavia 305', plan: 'basico',
    desc: 'Blanquería, cortinas y objetos de decoración para renovar tu casa.',
    hours: week(H('09:30', '13:00', '16:30', '20:00'), H('10:00', '13:30')),
    products: [['Juego de sábanas queen', 28000, '100% algodón, 144 hilos.'], ['Cortina blackout', 36500, 'Lista para colgar, 1,40 x 2 m.']] },
];

const REQUESTS = [
  ['Martina', 'calzado', 'Busco zapatillas talle 42, hasta $100.000, para retirar hoy en Luján', 100000, 'Centro', 'Hoy'],
  ['Pablo', 'ferreteria', 'Necesito un taladro percutor con maletín, para esta semana', 80000, 'San Fermín', 'Esta semana'],
  ['Lucía', 'libreria', 'Busco mochila escolar reforzada para primer grado', 40000, 'Centro', 'Este mes'],
];

async function clear() {
  const users = await db.all("SELECT id FROM users WHERE email LIKE '%@demo.pulso'");
  const imgs = [];
  for (const u of users) {
    const b = await db.get('SELECT id, logo, cover FROM businesses WHERE owner_id = ?', u.id);
    if (b) {
      imgs.push(b.logo, b.cover, ...(await db.all('SELECT photo FROM products WHERE business_id = ?', b.id)).map((p) => p.photo));
    }
    await db.run('DELETE FROM users WHERE id = ?', u.id);
  }
  imgs.forEach(lib.deleteImage);
  await db.run("DELETE FROM requests WHERE whatsapp LIKE '5490000%'");
  return { removed: users.length };
}

async function seed() {
  const hash = bcrypt.hashSync('demo12345', 10);
  let i = 0, created = 0;
  for (const d of DEMO) {
    const email = lib.slugify(d.name).replace(/-/g, '') + '@demo.pulso';
    if (await db.get('SELECT id FROM users WHERE email = ?', email)) { i++; continue; }
    const cat = await db.get('SELECT id FROM categories WHERE slug = ?', d.cat);
    const uid = await db.insert("INSERT INTO users (email, password_hash, name, role) VALUES (?, ?, ?, 'merchant')", email, hash, 'Demo');
    const cover = await img(d.name, 1600, 700, i, { max: 22 });
    const logo = await img(lib.initials(d.name), 400, 400, i + 1, { max: 4 });
    const until = d.plan === 'basico' ? null : lib.sqlPlusDays(30);
    const bid = await db.insert(`INSERT INTO businesses (owner_id, slug, name, category_id, description, address, zone, whatsapp, phone, hours_json, logo, cover, plan, plan_until, status, delivery)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', 'ambos')`, uid, await lib.uniqueSlug(d.name), d.name, cat ? cat.id : null, d.desc, d.address, d.zone,
    '2323 400000', '2323 400000', JSON.stringify(d.hours), logo, cover, d.plan, until);
    let j = 0;
    for (const [name, price, desc] of d.products) {
      const photo = await img(name, 900, 900, i + j++, { small: true, max: 14 });
      await db.run('INSERT INTO products (business_id, name, description, price, photo) VALUES (?, ?, ?, ?, ?)', bid, name, desc, price, photo);
    }
    if (d.plan !== 'basico') {
      await db.run('INSERT INTO promotions (business_id, title, description, conditions, starts_at, ends_at, code) VALUES (?, ?, ?, ?, ?, ?, ?)',
        bid, i % 2 ? '2x1 los martes' : '15% off pagando en efectivo', 'Exclusivo para clientes de Pulso.', 'Mostrando el código en el local. No acumulable con otras promociones.', lib.todayAR(), new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10), 'PULSO' + (i + 1));
    }
    created++; i++;
  }
  if (!(await db.get("SELECT id FROM requests WHERE whatsapp LIKE '5490000%'"))) {
    let k = 0;
    for (const [name, slug, description, budget, zone, deadline] of REQUESTS) {
      const cat = await db.get('SELECT id FROM categories WHERE slug = ?', slug);
      if (!cat) continue;
      await db.run('INSERT INTO requests (token, name, whatsapp, category_id, description, budget, zone, deadline, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        lib.token(12), name, '54900001111' + k++, cat.id, description, budget, zone, deadline, lib.sqlPlusDays(7));
    }
  }
  return { created };
}

module.exports = { seed, clear };

if (require.main === module) {
  (async () => {
    if (process.argv.includes('--clear')) {
      const out = await clear();
      console.log(`Demo eliminada (${out.removed} comercios).`);
    } else {
      await seed();
      console.log('Demo creada. Acceso a cualquier comercio demo: <nombre-sin-espacios>@demo.pulso / demo12345 (ej. calzadossanmartin@demo.pulso)');
    }
    process.exit(0);
  })().catch((e) => { console.error(e); process.exit(1); });
}
