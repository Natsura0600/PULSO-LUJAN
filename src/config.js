const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');

module.exports = {
  ROOT,
  DATA_DIR,
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  PORT: Number(process.env.PORT || 3000),
  BASE_URL: (process.env.BASE_URL || '').replace(/\/$/, ''),
  SESSION_SECRET: process.env.SESSION_SECRET || 'cambiar-este-secreto-en-produccion',
  IS_PROD: process.env.NODE_ENV === 'production' || !!process.env.VERCEL,
  // Neon/Vercel Postgres definen DATABASE_URL (o POSTGRES_URL). Sin ella se usa PGlite local.
  DATABASE_URL: process.env.DATABASE_URL || process.env.POSTGRES_URL || '',
  // Almacenamiento de fotos compatible con S3 (Cloudflare R2). Sin S3_BUCKET se usa DATA_DIR/uploads.
  S3: {
    bucket: process.env.S3_BUCKET || '',
    endpoint: process.env.S3_ENDPOINT || '', // R2: https://<ACCOUNT_ID>.r2.cloudflarestorage.com
    key: process.env.S3_ACCESS_KEY_ID || '',
    secret: process.env.S3_SECRET_ACCESS_KEY || '',
    publicUrl: (process.env.S3_PUBLIC_URL || '').replace(/\/$/, ''), // ej. https://fotos.pulsolujan.com.ar
  },
  TZ: 'America/Argentina/Buenos_Aires',
  SITE_NAME: process.env.SITE_NAME || 'Pulso Luján',
};
