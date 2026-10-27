// Prueba de punta a punta v3: Apps Script simulado + Worker real (worker.js) + Chromium como celular.
import fs from 'fs'; import path from 'path'; import vm from 'vm'; import http from 'http'; import crypto from 'crypto';
import { createRequire } from 'module'; import { fileURLToPath, pathToFileURL } from 'url';
const require = createRequire(import.meta.url);
process.on('unhandledRejection', e => { console.error(e); process.exit(2); });
const { chromium } = require('playwright');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..'), TZ = 'America/Bogota';
const horario = JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'horario.json'), 'utf8'));

// ---------- Hoja simulada ----------
const cell = x => (x === undefined || x === null ? '' : String(x));
function mkSheet(rows) {
  const data = rows.map(r => r.slice());
  return {
    data,
    getDataRange() { return { getValues: () => data, getDisplayValues: () => data.map(r => r.map(cell)) }; },
    getLastRow() { return data.length; },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        setNumberFormat() { return this; }, setNumberFormats() { return this; },
        setValue(v) { data[r - 1][c - 1] = v; return this; },
        setValues(v) { for (let i = 0; i < nr; i++) { data[r - 1 + i] = data[r - 1 + i] || []; for (let j = 0; j < nc; j++) data[r - 1 + i][c - 1 + j] = v[i][j]; } return this; },
        getDisplayValues() { const o = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push(cell((data[r - 1 + i] || [])[c - 1 + j])); o.push(row); } return o; }
      };
    }
  };
}
const parts = d => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hour12: false }).formatToParts(d).map(x => [x.type, x.value]));
function formatDate(d, tz, p) {
  const q = parts(d), h = q.hour === '24' ? '00' : q.hour;
  return { 'yyyy-MM-dd': `${q.year}-${q.month}-${q.day}`, 'HH:mm:ss': `${h}:${q.minute}:${q.second}`, 'HH:mm': `${h}:${q.minute}`,
    'u': String(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(q.weekday) + 1) }[p];
}
const DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const now = new Date(), hoy = DIAS[Number(formatDate(now, TZ, 'u')) - 1];
const hm = m => ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2);
const nowMin = (() => { const [h, m] = formatDate(now, TZ, 'HH:mm').split(':').map(Number); return h * 60 + m; })();
const ini = hm(Math.max(0, nowMin - 3)), fin = hm(Math.min(1439, nowMin + 60));
const prueba = { '06667': 'AG101', '07784': 'AG102', '07428': 'LG107', '05497': 'AG103', '04068': 'AG104', '01243': 'LE103' };
const docs = [...new Map(horario.map(r => [r.cd, r.nom]))];
const sinClaseHoy = docs.find(([c]) => !prueba[c] && !horario.some(r => r.cd === c && r.dia === hoy))[0];
const TOKEN = Object.fromEntries(docs.map(([c]) => [c, crypto.randomBytes(16).toString('hex')]));
const H = [['ID clase', 'Día', 'Hora inicio', 'Hora fin', 'Código materia', 'Materia', 'Código docente', 'Docente', 'Salón', 'Alumnos']]
  // Las clases reales de hoy de los docentes de prueba se quitan para que la prueba no dependa de la hora en que corre
  .concat(horario.filter(r => !(prueba[r.cd] && r.dia === hoy)).map(r => [r.id, r.dia, r.ini, r.fin, r.cm, r.mat, r.cd, r.nom, r.sal, r.alu]))
  .concat(Object.entries(prueba).map(([cd, sal], i) => ['TEST-' + i, hoy, ini, fin, 'PRUEBA' + i, 'CLASE DE PRUEBA ' + i, cd, docs.find(d => d[0] === cd)[1], sal, 10]));
const config = [['Parámetro', 'Valor'], ['URL del Worker', 'http://localhost:8791'], ['Correo del coordinador', 'coord@ufps.edu.co'],
  ['Validación de red WiFi (NO/ALERTA/EXIGIR)', 'ALERTA'], ['Latitud del campus', 7.898115], ['Longitud del campus', -72.488703], ['Radio permitido (m)', 300],
  ['Precisión GPS máxima (m)', 100], ['Lecturas GPS mínimas', 3], ['Bloquear si cambia el celular (SI/NO)', 'SI'], ['Exigir foto en vivo (SI/NO)', 'NO'],
  ['Correo inmediato por alertas (SI/NO)', 'SI'], ['Minutos antes del inicio para registrar', 15], ['Tolerancia de llegada (min)', 10],
  ['Enviar alertas de no registro (SI/NO)', 'SI'], ['Fecha inicio de control', '2026-10-01'], ['Fecha fin de control', '']];
const sheets = {
  Config: mkSheet(config), Horario: mkSheet(H),
  Docentes: mkSheet([['Código', 'Docente', 'Cat', 'Correo', 'Activo', 'Clave', 'Celular', 'Enlace']].concat(docs.map(([c, n]) => [c, n, '', '', 'SI', TOKEN[c], '', '']))),
  Salones: mkSheet([['Salón', 'Exige', 'Lat', 'Lng', 'Radio']].concat([...new Set(horario.map(r => r.sal))].map(s => [s, s === 'TE000' ? 'NO' : 'SI', '', '', '']))),
  Redes: mkSheet([['Rango', 'Org', 'Docentes', 'Registros', 'Última', 'Aprobada'], ['200.21.5.0/24', 'Red UFPS (Sistemas)', '', '', '', 'SI']]),
  Festivos: mkSheet([['Fecha', 'Desc']]), Registros: mkSheet([['h']]), Asistencia: mkSheet([['h']])
};
const setConfig = (k, v) => { sheets.Config.data.find(f => f[0] === k)[1] = v; };

// ---------- Servicios de Apps Script simulados ----------
const SECRETO = crypto.randomBytes(24).toString('hex');
const props = {}, mails = [];
const signed = buf => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const ctx = {
  console,
  SpreadsheetApp: { getActive: () => ({ getSheetByName: n => sheets[n], insertSheet: n => (sheets[n] = mkSheet([])), getUrl: () => 'https://docs.google.com/spreadsheets/d/TEST' }), getUi: () => { throw new Error('sin UI'); } },
  Session: { getScriptTimeZone: () => TZ },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  MailApp: { sendEmail: (to, s, b, o) => mails.push({ to, s, b, o }), getRemainingDailyQuota: () => 100 },
  Logger: { log() {} },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: s => ({ s, setMimeType() { return this; } }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => (props[k] = v) }) },
  DriveApp: { createFolder: () => ({ getId: () => 'F', getFoldersByName: () => ({ hasNext: () => false }), createFolder: () => ({ createFile: b => ({ getUrl: () => 'drive://' + b.name }) }) }), getFolderById: () => { throw 1; } },
  Utilities: {
    formatDate, Charset: { UTF_8: 'utf8' }, DigestAlgorithm: { SHA_256: 'sha256' },
    computeHmacSha256Signature: (v, k) => signed(crypto.createHmac('sha256', Buffer.from(k, 'utf8')).update(Buffer.from(v, 'utf8')).digest()),
    computeDigest: (alg, v) => signed(crypto.createHash('sha256').update(Buffer.from(v, 'utf8')).digest()),
    getUuid: () => crypto.randomUUID(), base64Decode: s => Buffer.from(s, 'base64'), newBlob: (bytes, type, name) => ({ bytes, type, name })
  }
};
vm.createContext(ctx);
// Igual que en GitHub Actions: el secreto llega como archivo zz_secreto.gs
vm.runInContext(`var SECRETO_WORKER_CI = '${SECRETO}';`, ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script', 'Code.gs'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'apps-script', 'asesorias_datos.gs'), 'utf8'), ctx);

// "Apps Script" (puerto 8790)
const gas = http.createServer((req, res) => {
  let body = ''; req.on('data', d => (body += d)); req.on('end', () => {
    const out = req.method === 'POST' ? ctx.doPost({ postData: { contents: body } }) : ctx.doGet();
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(out.s);
  });
});

// Worker real (worker.js) servido como si fuera Cloudflare (puerto 8791)
fs.copyFileSync(path.join(ROOT, 'worker', 'dist', 'worker.js'), path.join(ROOT, 'test', '.worker.mjs'));
const worker = (await import(pathToFileURL(path.join(ROOT, 'test', '.worker.mjs')).href)).default;
const env = { APPS_SCRIPT_URL: 'http://localhost:8790/exec', SECRETO };
const RED_UFPS = { ip: '200.21.5.40', asn: 27951, asOrganization: 'Red UFPS', city: 'Cúcuta' };
const RED_CASA = { ip: '181.50.3.7', asn: 10620, asOrganization: 'Telmex Colombia S.A. (Claro)', city: 'Cúcuta' };
let redActual = RED_UFPS;
const cfw = http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) headers.set(k, v);
  headers.set('CF-Connecting-IP', redActual.ip); // Cloudflare sobrescribe este encabezado con la IP real
  const request = new Request('http://localhost:8791' + req.url, { method: req.method, headers, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined });
  Object.defineProperty(request, 'cf', { value: { asn: redActual.asn, asOrganization: redActual.asOrganization, city: redActual.city } });
  const r = await worker.fetch(request, env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
});

// "GitHub Pages" (puerto 8792): sirve dist-pagina/ en otro dominio y apunta a la API del Worker
const DIST = path.join(ROOT, 'dist-pagina');
const pages = http.createServer((req, res) => {
  let ruta = decodeURIComponent(req.url.split('?')[0]).replace(/^\/pulso-ufps\/?/, '') || 'index.html';
  if (ruta === 'config.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end("window.PULSO_API = 'http://localhost:8791/api';"); }
  const f = path.join(DIST, ruta);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
  const tipo = { html: 'text/html; charset=utf-8', js: 'application/javascript', png: 'image/png', webmanifest: 'application/manifest+json' }[f.split('.').pop()];
  res.writeHead(200, { 'Content-Type': tipo || 'application/octet-stream' }); res.end(fs.readFileSync(f));
});

// ---------- Utilidades ----------
let fallas = 0;
const check = (n, c, x) => { if (!c) fallas++; console.log((c ? 'OK   ' : 'FALLA') + ' ' + n + (x ? '  → ' + x : '')); };
const UFPS = { latitude: 7.8983, longitude: -72.4889 };
const JITTER = `(() => { const g = navigator.geolocation, o = g.getCurrentPosition.bind(g); let i = 0;
  g.getCurrentPosition = (ok, err, opt) => o(p => { i++; const c = p.coords; ok({ timestamp: Date.now(), coords: { latitude: c.latitude + i * 0.000013,
    longitude: c.longitude - i * 0.000009, accuracy: 14 + i * 3, altitude: 320, altitudeAccuracy: 8, heading: null, speed: null } }); }, err, opt); })();`;
async function celular(browser, { geo = UFPS, accuracy = 20, jitter = true, permisos = ['geolocation'] } = {}) {
  const c = await browser.newContext({ permissions: permisos, geolocation: geo ? { ...geo, accuracy } : undefined, viewport: { width: 390, height: 844 } });
  if (jitter) await c.addInitScript(JITTER);
  return c;
}
let BASE = 'http://localhost:8791/';
async function abrir(page, codigo) {
  await page.goto(BASE + '?d=' + (TOKEN[codigo] || codigo));
  await page.waitForFunction(() => document.getElementById('resInicial').className.includes('res ') || !document.getElementById('clase').classList.contains('oculto'), null, { timeout: 20000 });
  return page.evaluate(() => ({ inicial: document.getElementById('resInicial').className.includes('res ') ? document.getElementById('resInicial').innerText : '',
    hola: document.getElementById('hola').innerText, clase: document.getElementById('clase').innerText, flujo: !document.getElementById('flujo').classList.contains('oculto') }));
}
async function registrar(page, codigo) {
  const e = await abrir(page, codigo);
  if (e.inicial) return { etapa: 'abrir', texto: e.inicial };
  if (!e.flujo) return { etapa: 'sin clase', texto: e.clase };
  await page.waitForFunction(() => /ok|err/.test(document.getElementById('dGps').className), null, { timeout: 40000 });
  const gpsErr = await page.$eval('#dGps', el => el.className.includes('err'));
  if (gpsErr) return { etapa: 'gps', texto: await page.$eval('#tGps', el => el.innerText) };
  await page.click('#registrar');
  await page.waitForFunction(() => /res (ok|aviso|error)/.test(document.getElementById('res').className + ' ' + document.getElementById('resInicial').className), null, { timeout: 20000 });
  return { etapa: 'registrar', texto: await page.evaluate(() => (document.getElementById('resInicial').className.includes('res ') ? document.getElementById('resInicial') : document.getElementById('res')).innerText) };
}
const fila = cd => sheets.Asistencia.data.find(f => f[7] === cd && String(f[2]).startsWith('TEST'));

await new Promise(r => gas.listen(8790, r)); await new Promise(r => cfw.listen(8791, r)); await new Promise(r => pages.listen(8792, r));
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
console.log('Hoy ' + hoy + ', clases de prueba ' + ini + '–' + fin + '\n');

// Funciones de red
check('IPv4 dentro del rango', ctx.ipEnRango_('200.21.5.40', '200.21.5.0/24') && !ctx.ipEnRango_('200.21.6.1', '200.21.5.0/24'));
check('IPv6 dentro/fuera del rango /48', ctx.ipEnRango_('2800:e2:1a00:12::5', '2800:e2:1a00::/48') && !ctx.ipEnRango_('2800:e2:1b00::1', '2800:e2:1a00::/48'));

// 1. Docente legítimo en la U, conectado al WiFi
const tel1 = await celular(browser);
const p1 = await tel1.newPage();
const e1 = await abrir(p1, '06667');
check('La página muestra al docente y su clase actual', /BARBOSA|GEINER/.test(e1.hola + e1.clase) || /Hola/.test(e1.hola) && /AG101/.test(e1.clase), e1.hola + ' | ' + e1.clase.replace(/\n/g, ' '));
const r1 = await registrar(p1, '06667');
const f1 = fila('06667');
check('Registro legítimo aceptado, en red UFPS, sin alertas', /registrada/.test(r1.texto) && f1 && f1[13] === 'SI' && f1[15] === '', f1 && `red=${f1[13]} alertas="${f1[15]}"`);

// Identidad visual: logos, íconos y manifiesto servidos por el Worker
const logos = await p1.evaluate(() => [...document.images].filter(i => /assets/.test(i.src)).map(i => i.naturalWidth > 0));
check('Logos UFPS cargados en la página', logos.length >= 3 && logos.every(Boolean), logos.length + ' imágenes');
const man = await (await fetch('http://localhost:8791/manifest.webmanifest')).json();
const ico = await fetch('http://localhost:8791/assets/icono-512.png');
check('Manifiesto e ícono de pantalla de inicio', man.theme_color === '#E2031A' && !man.start_url && ico.headers.get('content-type') === 'image/png', man.short_name);
if (process.env.CAPTURAS) await p1.screenshot({ path: process.env.CAPTURAS + '/registro_ok.png', fullPage: true });

// 2. Enlace inválido
const r2 = await registrar(await tel1.newPage(), 'x'.repeat(32));
check('Enlace inválido rechazado', /no válido/.test(r2.texto), r2.texto.split('\n')[0]);

// 3. Saltarse el Worker y llamar directo al Apps Script con datos inventados
const directo = await (await fetch('http://localhost:8790/exec', { method: 'POST', body: JSON.stringify({ payload: JSON.stringify({ accion: 'registrar', token: TOKEN['07784'] }), red: RED_UFPS, firma: 'f'.repeat(64) }) })).json();
check('Llamada directa sin firma del Worker rechazada', /no autorizado/.test(directo.titulo), directo.titulo);
const pl = JSON.stringify({ accion: 'estado', token: TOKEN['07784'] }), viejo = { ip: '200.21.5.40', asn: '1', org: 'x', ciudad: 'y', ts: Date.now() - 600000 };
const fViejo = crypto.createHmac('sha256', SECRETO).update([viejo.ip, viejo.asn, viejo.org, viejo.ciudad, viejo.ts, crypto.createHash('sha256').update(pl).digest('hex')].join('|')).digest('hex');
const rep = await (await fetch('http://localhost:8790/exec', { method: 'POST', body: JSON.stringify({ payload: pl, red: viejo, firma: fViejo }) })).json();
check('Solicitud firmada pero vieja (repetición) rechazada', /no autorizado/.test(rep.titulo));

// 4. GPS falso desde la casa (modo ALERTA): se acepta pero queda marcado
redActual = RED_CASA;
const tel2 = await celular(browser, { jitter: false, accuracy: 1 });
const r4 = await registrar(await tel2.newPage(), '07784');
const f4 = fila('07784');
check('GPS falso desde la casa → aceptado con alertas (modo ALERTA)', /registrada/.test(r4.texto) && f4 && /Fuera de la red/.test(f4[15]) && /congeladas/.test(f4[15]), f4 && f4[15]);
check('Correo inmediato al coordinador', mails.some(m => /registro con alerta/.test(m.s)));

// 5. Modo EXIGIR: desde la casa con GPS falso "realista" → rechazado
setConfig('Validación de red WiFi (NO/ALERTA/EXIGIR)', 'EXIGIR');
const tel3 = await celular(browser);
const p3 = await tel3.newPage();
const r5 = await registrar(p3, '07428');
if (process.env.CAPTURAS) await p3.screenshot({ path: process.env.CAPTURAS + '/wifi_error.png', fullPage: true });
check('Modo EXIGIR: GPS falso perfecto pero fuera del WiFi UFPS → rechazado', /WiFi de la universidad/.test(r5.texto), r5.texto.split('\n')[0]);
check('La página marca en rojo el WiFi', await p3.$eval('#dWifi', el => el.className.includes('err')));
// ... se conecta al WiFi y reintenta en la misma página
redActual = RED_UFPS;
await p3.click('#registrar');
await p3.waitForFunction(() => document.getElementById('resInicial').className.includes('res '), null, { timeout: 20000 });
check('Tras conectarse al WiFi UFPS el mismo intento pasa', /registrada/.test(await p3.$eval('#resInicial', el => el.innerText)));

// 6. GPS fuera del campus (aunque esté en la red)
const tel4 = await celular(browser, { geo: { latitude: 7.8891, longitude: -72.4967 } });
const r6 = await registrar(await tel4.newPage(), '05497');
check('Ubicación fuera del campus rechazada', /Fuera de la universidad/.test(r6.texto), r6.texto.split('\n')[0]);

// 7. Enlace reenviado a otro celular
const r7 = await registrar(await (await celular(browser)).newPage(), '06667');
check('Enlace reenviado a otro celular → no autorizado', /Celular no autorizado/.test(r7.texto), r7.texto.split('\n')[0]);

// 8. Duplicado en el celular correcto
const r8 = await registrar(await tel1.newPage(), '06667');
check('Segundo registro de la misma clase → "Ya estaba registrada"', /Ya estaba registrada/.test(r8.texto));

// 9. Sin permiso de ubicación
const r9 = await registrar(await (await celular(browser, { permisos: [] })).newPage(), '04068');
check('Sin permiso de ubicación → no deja registrar', r9.etapa === 'gps' && /denegado/.test(r9.texto), r9.texto);

// 10. Docente sin clase en este momento
const p10 = await (await celular(browser)).newPage();
const e10 = await abrir(p10, sinClaseHoy);
if (process.env.CAPTURAS) await p10.screenshot({ path: process.env.CAPTURAS + '/sin_clase.png', fullPage: true });
check('Docente sin clase ahora: no aparece el botón de registro', !e10.flujo && /No tienes más clases|próxima/i.test(e10.clase), e10.clase.replace(/\n/g, ' '));

// 10b. Página publicada en GitHub Pages (index.html en otro dominio) → API del Worker por CORS
BASE = 'http://localhost:8792/pulso-ufps/';
const pPages = await (await celular(browser)).newPage();
const rP = await registrar(pPages, '01243');
const logosP = await pPages.evaluate(() => [...document.images].filter(i => /assets/.test(i.src)).every(i => i.naturalWidth > 0));
check('GitHub Pages: index.html registra a través del Worker (CORS)', /registrada/.test(rP.texto) && logosP, rP.texto.split('\n')[0]);
const pre = await fetch('http://localhost:8791/api', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8792' } });
check('Worker responde la verificación CORS', pre.status === 204 && pre.headers.get('access-control-allow-origin'));
if (process.env.CAPTURAS) await pPages.screenshot({ path: process.env.CAPTURAS + '/pages.png', fullPage: true });
// config.js del repositorio sin editar (GitHub Pages "desde la rama" sin configurar) → aviso claro
const pSin = await (await celular(browser)).newPage();
await pSin.route('**/config.js', r => r.fulfill({ contentType: 'application/javascript', body: fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8') }));
await pSin.goto(BASE + '?d=' + TOKEN['01243']);
await pSin.waitForFunction(() => document.getElementById('resInicial').className.includes('res '));
check('index.html sin configurar muestra aviso claro', /sin configurar/i.test(await pSin.$eval('#resInicial', e => e.innerText)));
BASE = 'http://localhost:8791/';

// 11. Aprendizaje de redes
ctx.detectarRedes();
const redUfps = sheets.Redes.data.find(f => f[0] === '200.21.5.0/24');
const redCasa = sheets.Redes.data.find(f => f[0] === '181.50.3.0/24');
check('Redes: la red UFPS se actualiza con docentes y registros', redUfps && Number(redUfps[2]) >= 2, redUfps && `${redUfps[2]} docentes, ${redUfps[3]} registros`);
check('Redes: la conexión con GPS sospechoso no se aprende', !redCasa);

// 12. Recordatorio diario: un correo por docente con clase hoy, con su enlace
const antes = mails.length;
for (const f of sheets.Docentes.data.slice(1)) if (prueba[f[0]]) f[3] = 'doc' + f[0] + '@ufps.edu.co';
const nRec = ctx.recordatorioDiario();
const rec = mails.slice(antes);
const conClaseHoy = new Set(H.slice(1).filter(r => r[1] === hoy).map(r => r[6]));
const esperados = Object.keys(prueba).filter(c => conClaseHoy.has(c)).length;
check('Recordatorio diario: un correo por docente con clase hoy', nRec === esperados && rec.length === esperados, nRec + ' enviados');
check('Recordatorio incluye clases y enlace personal', rec.every(m => /CLASE DE PRUEBA/.test(m.b) && m.b.includes('?d=') && m.o && /Pulso/.test(m.o.name)), rec[0] && rec[0].s);

// 13. Asesorías: se cargan en su hoja, agregan docentes nuevos y se registran como una clase
const nDoc = sheets.Docentes.data.length;
ctx.cargarAsesorias();
const hA = sheets['Asesorías'];
check('Asesorías cargadas en su propia hoja', hA && hA.data.length - 1 === ctx.ASESORIAS_2026_2.length && hA.data[0][0] === 'ID clase', hA && (hA.data.length - 1) + ' bloques');
check('Docentes nuevos de asesorías agregados a Docentes', sheets.Docentes.data.length === nDoc + ctx.DOCENTES_NUEVOS_ASESORIAS.length && ctx.DOCENTES_NUEVOS_ASESORIAS.every(d => sheets.Docentes.data.some(f => f[0] === d[0])));
check('Asesorías unidas al horario', ctx.leerHorario_().filter(c => c.asesoria).length === ctx.ASESORIAS_2026_2.length);
const nomSin = docs.find(d => d[0] === sinClaseHoy)[1];
hA.data.push(['ASE-TEST', hoy, ini, fin, 'ASESORIA', 'ASESORÍA · Ing. Electrónica', sinClaseHoy, nomSin, '', 'Electrónica']);
const pAse = await (await celular(browser)).newPage();
const eAse = await abrir(pAse, sinClaseHoy);
const rAse = await registrar(pAse, sinClaseHoy);
check('La página muestra la asesoría actual', /asesoría ahora/i.test(eAse.clase) && /ASESORÍA/.test(eAse.clase), eAse.clase.replace(/\n/g, ' '));
check('Asesoría registrada como asistencia', /registrada/.test(rAse.texto) && sheets.Asistencia.data.some(f => f[2] === 'ASE-TEST' && /A tiempo|Tarde/.test(f[12])), rAse.texto.split('\n')[0]);

// 14. Tablero de salones para los becas trabajo
const CLAVE_T = 'clave-tablero-prueba-123456';
sheets.Config.data.push(['Clave del tablero (becas trabajo)', CLAVE_T]);
const tab = async (o) => (await fetch('http://localhost:8791/api', { method: 'POST', body: JSON.stringify(o) })).json();
const t0 = await tab({ accion: 'tablero', clave: 'otra' });
check('Tablero con clave equivocada → rechazado', !t0.ok && /no válido/.test(t0.titulo));
const t1 = await tab({ accion: 'tablero', clave: CLAVE_T });
const item = (t, id) => t.sectores.flatMap(s => s.items.map(i => ({ ...i, sector: s.id }))).find(i => i.id === id);
check('Tablero agrupa por bloques AG, LE y LG', t1.ok && ['AG', 'LE', 'LG'].every(id => t1.sectores.some(s => s.id === id)), t1.sectores && t1.sectores.map(s => s.id + ':' + s.items.length).join(' '));
check('Docente registrado → su salón aparece "abrir"', item(t1, 'TEST-0') && item(t1, 'TEST-0').estado === 'abrir' && item(t1, 'TEST-0').sector === 'AG' && item(t1, 'TEST-5').sector === 'LE');
check('Docente que no ha registrado → "esperando"', item(t1, 'TEST-4') && item(t1, 'TEST-4').estado === 'esperando');
check('Asesoría sin salón va a su propio grupo', item(t1, 'ASE-TEST') && item(t1, 'ASE-TEST').sector === 'ASESORIAS');
const pT = await (await browser.newContext({ viewport: { width: 1200, height: 900 } })).newPage();
await pT.goto('http://localhost:8792/pulso-ufps/tablero.html?k=' + CLAVE_T);
await pT.waitForSelector('.card.abrir .ok', { timeout: 20000 });
await pT.fill('#quien', 'Beca de prueba'); await pT.$eval('#quien', e => e.dispatchEvent(new Event('change')));
if (process.env.CAPTURAS) await pT.screenshot({ path: process.env.CAPTURAS + '/tablero.png', fullPage: true });
const pTm = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
await pTm.goto('http://localhost:8792/pulso-ufps/tablero.html?k=' + CLAVE_T);
await pTm.waitForSelector('.card.abrir', { timeout: 20000 });
if (process.env.CAPTURAS) await pTm.screenshot({ path: process.env.CAPTURAS + '/tablero_celular.png', fullPage: true });
const porAbrir = await pT.$$eval('.card.abrir', e => e.length);
await pT.click('.card.abrir .ok');
await pT.waitForFunction(n => document.querySelectorAll('.card.abrir').length === n - 1, porAbrir, { timeout: 20000 });
const ap = sheets.Aperturas && sheets.Aperturas.data.slice(1);
check('Beca marca "Ya abrí el salón" → queda en Aperturas', ap && ap.length === 1 && ap[0][5] === 'Beca de prueba', ap && ap[0] && ap[0].slice(2, 6).join(' · '));
const t2 = await tab({ accion: 'tablero', clave: CLAVE_T });
check('Salón abierto deja de pedir apertura', item(t2, ap[0][2]).estado === 'abierto');

console.log('\nRegistros: ' + (sheets.Registros.data.length - 1) + ' · Asistencia: ' + (sheets.Asistencia.data.length - 1) + ' · Correos: ' + mails.length);
console.log(fallas ? '\n' + fallas + ' FALLAS' : '\nTODAS LAS PRUEBAS OK');
await browser.close(); gas.close(); cfw.close(); pages.close();
process.exit(fallas ? 1 : 0);
