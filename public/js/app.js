// Pulso Luján — interacciones del cliente
(function () {
  'use strict';
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  document.addEventListener('DOMContentLoaded', function () {
    // Compartir
    $$('[data-share]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const data = { title: b.dataset.title, url: b.dataset.url };
        if (navigator.share) { try { await navigator.share(data); } catch (e) { /* cancelado */ } return; }
        copy(data.url, b);
      });
    });
    // Copiar enlace
    $$('[data-copy]').forEach(function (b) { b.addEventListener('click', function () { copy(b.dataset.copy, b); }); });
    // Confirmación antes de enviar
    $$('form[data-confirm]').forEach(function (f) {
      f.addEventListener('submit', function (e) { if (!confirm(f.dataset.confirm)) { e.preventDefault(); e.stopImmediatePropagation(); } });
    });
    // Auto-envío de selects
    $$('[data-autosubmit]').forEach(function (s) { s.addEventListener('change', function () { s.form.submit(); }); });
    // Vista previa de imagen
    $$('[data-preview-input]').forEach(function (inp) {
      inp.addEventListener('change', function () {
        const img = inp.parentElement.querySelector('[data-preview]');
        if (img && inp.files && inp.files[0]) { img.src = URL.createObjectURL(inp.files[0]); img.classList.remove('hidden'); }
      });
    });
    // Filtro local de listas
    $$('[data-filter]').forEach(function (inp) {
      inp.addEventListener('input', function () {
        const q = norm(inp.value);
        $$(inp.dataset.filter).forEach(function (el) { el.style.display = norm(el.textContent).includes(q) ? '' : 'none'; });
      });
    });
    // Copiar horario del lunes a martes-viernes
    $$('[data-copy-hours]').forEach(function (b) {
      b.addEventListener('click', function () {
        const src = document.querySelector('.hrow[data-day="1"]');
        if (!src) return;
        const vals = $$('input', src).map(function (i) { return i.type === 'checkbox' ? i.checked : i.value; });
        [2, 3, 4, 5].forEach(function (d) {
          const row = document.querySelector('.hrow[data-day="' + d + '"]');
          $$('input', row).forEach(function (i, k) { if (i.type === 'checkbox') i.checked = vals[k]; else i.value = vals[k]; });
        });
        b.textContent = 'Listo ✓ (recordá guardar)';
      });
    });
    // Achicar fotos antes de subirlas (el servidor acepta hasta 4 MB por foto y 4,5 MB por envío)
    $$('input[type=file][accept^="image"]').forEach(function (inp) {
      inp.addEventListener('change', async function () {
        if (!inp.files || !inp.files.length || !window.DataTransfer) return;
        const dt = new DataTransfer();
        for (const f of Array.from(inp.files)) dt.items.add(await shrink(f));
        inp.files = dt.files;
      });
    });
    // Evitar doble envío
    $$('form').forEach(function (f) {
      f.addEventListener('submit', function (e) {
        if (e.defaultPrevented) return;
        setTimeout(function () { $$('button:not([type=button])', f).forEach(function (b) { b.disabled = true; }); }, 0);
        setTimeout(function () { $$('button', f).forEach(function (b) { b.disabled = false; }); }, 8000);
      });
    });
  });

  function shrink(file, max) {
    max = max || 1600;
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type) || file.size < 600 * 1024) return resolve(file);
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = function () {
        const k = Math.min(1, max / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) {
          if (!b || b.size >= file.size) return resolve(file);
          resolve(new File([b], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }));
        }, 'image/jpeg', 0.85);
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
  function copy(text, btn) {
    const done = function () { const t = btn.textContent; btn.textContent = '¡Copiado!'; setTimeout(function () { btn.textContent = t; }, 1800); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, function () { prompt('Copiá el enlace:', text); });
    else prompt('Copiá el enlace:', text);
  }

  // App instalable (PWA)
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
})();
