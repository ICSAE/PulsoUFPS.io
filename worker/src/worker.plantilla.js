/**
 * CLOUDFLARE WORKER – Pulso · Asistencia docente UFPS
 *
 * Puente entre la página del docente (GitHub Pages o este mismo Worker) y Apps Script:
 * reenvía cada solicitud agregando la IP REAL
 * de la conexión (la que ve Cloudflare; el celular no puede cambiarla), firmada con un secreto.
 *
 * Variables del Worker (Settings → Variables and Secrets):
 *   APPS_SCRIPT_URL = URL de la aplicación web de Apps Script (termina en /exec)
 *   SECRETO         = el secreto WORKER_SECRETO del repositorio (lo carga el workflow)
 *   ORIGEN_PAGINA   = (opcional) dominio de GitHub Pages permitido, ej. https://usuario.github.io
 */
// Archivos de la carpeta pagina/ (index.html, config.js, manifest y logos), incrustados al compilar.
const ARCHIVOS = __ARCHIVOS__;
const TIPOS = { html: 'text/html; charset=utf-8', js: 'application/javascript; charset=utf-8', webmanifest: 'application/manifest+json', png: 'image/png' };
const SEGURIDAD = {
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'geolocation=(self), camera=(self), microphone=()'
};

function archivo(ruta) {
  const f = ARCHIVOS[ruta];
  if (!f) return null;
  const ext = ruta.split('.').pop();
  const cuerpo = f.b64 ? Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)) : f.texto;
  return new Response(cuerpo, { headers: { 'content-type': TIPOS[ext] || 'application/octet-stream',
    'cache-control': ext === 'png' ? 'public, max-age=604800' : 'no-store', 'x-frame-options': 'DENY', ...SEGURIDAD } });
}

/** CORS: la página publicada en GitHub Pages llama a esta API desde otro dominio. */
function cors(env, request) {
  const permitido = env.ORIGEN_PAGINA || '*';
  const origen = request.headers.get('Origin') || '';
  return {
    'access-control-allow-origin': permitido === '*' ? '*' : (origen === permitido ? origen : permitido),
    'access-control-allow-methods': 'POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}

const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
async function sha256Hex(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function hmacHex(clave, msg) {
  const k = await crypto.subtle.importKey('raw', enc.encode(clave), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', k, enc.encode(msg)));
}
const json = (o, status = 200, extra = {}) => new Response(JSON.stringify(o), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extra }
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api') {
      const c = cors(env, request);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: c });
      if (request.method !== 'POST') return json({ ok: false }, 405, c);
      if (!env.APPS_SCRIPT_URL || !env.SECRETO) return json({ ok: false, tipo: 'error', titulo: 'Worker sin configurar', mensaje: 'Faltan APPS_SCRIPT_URL o SECRETO.' }, 500, c);
      const payload = await request.text();
      if (payload.length > 2500000) return json({ ok: false, tipo: 'error', titulo: 'Solicitud demasiado grande', mensaje: '' }, 413, c);
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
        return new Response(texto, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...c } });
      } catch (e) {
        return json({ ok: false, tipo: 'error', titulo: 'Servidor no disponible', mensaje: 'Inténtalo de nuevo en unos segundos.' }, 502, c);
      }
    }

    // Página del docente (la misma que publica GitHub Pages)
    const ruta = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (ruta === 'favicon.ico') return archivo('assets/icono-192.png');
    return archivo(ruta) || archivo('index.html');
  }
};
