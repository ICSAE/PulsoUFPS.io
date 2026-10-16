/**
 * CLOUDFLARE WORKER – Pulso · Asistencia docente UFPS
 *
 * Sirve la página del docente y reenvía cada solicitud al Apps Script agregando la IP REAL
 * de la conexión (la que ve Cloudflare; el celular no puede cambiarla), firmada con un secreto.
 *
 * Variables del Worker (Settings → Variables and Secrets):
 *   APPS_SCRIPT_URL = URL de la aplicación web de Apps Script (termina en /exec)
 *   SECRETO         = el secreto WORKER_SECRETO del repositorio (lo carga el workflow)
 */
const HTML = __HTML__;
const ASSETS = __ASSETS__; // logos e íconos UFPS en base64 (worker/src/assets)

const MANIFEST = JSON.stringify({
  name: 'Pulso – Asistencia docente UFPS',
  short_name: 'Pulso UFPS',
  description: 'Asistencia docente del Departamento de Electricidad y Electrónica – UFPS',
  display: 'standalone',
  background_color: '#F5F5F7',
  theme_color: '#E2031A',
  lang: 'es-CO',
  icons: [
    { src: '/assets/icono-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
    { src: '/assets/icono-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
  ]
  // Sin start_url: el ícono abre la misma dirección (con el enlace personal) desde la que se instaló.
});

function asset(nombre) {
  const b64 = ASSETS[nombre];
  if (!b64) return new Response('No encontrado', { status: 404 });
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' } });
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmacHex(clave, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(clave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const json = (o, status = 200) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api') {
      if (request.method !== 'POST') return json({ ok: false }, 405);
      if (!env.APPS_SCRIPT_URL || !env.SECRETO) return json({ ok: false, tipo: 'error', titulo: 'Worker sin configurar', mensaje: 'Faltan APPS_SCRIPT_URL o SECRETO.' }, 500);
      const payload = await request.text();
      if (payload.length > 2500000) return json({ ok: false, tipo: 'error', titulo: 'Solicitud demasiado grande', mensaje: '' }, 413);
      const cf = request.cf || {};
      const red = {
        ip: request.headers.get('CF-Connecting-IP') || '',
        asn: String(cf.asn || ''),
        org: String(cf.asOrganization || ''),
        ciudad: String(cf.city || ''),
        ts: Date.now()
      };
      const firma = await hmacHex(env.SECRETO, [red.ip, red.asn, red.org, red.ciudad, red.ts, await sha256Hex(payload)].join('|'));
      try {
        const r = await fetch(env.APPS_SCRIPT_URL, { method: 'POST', body: JSON.stringify({ payload, red, firma }), redirect: 'follow' });
        const texto = await r.text();
        JSON.parse(texto);
        return new Response(texto, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      } catch (e) {
        return json({ ok: false, tipo: 'error', titulo: 'Servidor no disponible', mensaje: 'Inténtalo de nuevo en unos segundos.' }, 502);
      }
    }

    if (url.pathname.startsWith('/assets/')) return asset(url.pathname.slice(8));
    if (url.pathname === '/manifest.webmanifest') {
      return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=86400' } });
    }
    if (url.pathname === '/favicon.ico') return asset('icono-192.png');

    return new Response(HTML, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'referrer-policy': 'no-referrer',
        'x-frame-options': 'DENY',
        'x-content-type-options': 'nosniff',
        'permissions-policy': 'geolocation=(self), camera=(self), microphone=()'
      }
    });
  }
};
