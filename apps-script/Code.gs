/**
 * PULSO – ASISTENCIA DOCENTE (enlace personal + red de la universidad)
 * UFPS – Departamento de Electricidad y Electrónica
 *
 * Cómo funciona:
 *  - Cada docente tiene un enlace personal (lo guarda en su celular). Lo abre cuando está en clase.
 *  - La página corre en un Cloudflare Worker gratuito que agrega la IP REAL de la conexión,
 *    firmada con un secreto. Así se sabe si el celular está conectado al WiFi de la universidad.
 *    Un GPS falso puede mentir sobre la ubicación, pero desde la casa la conexión no sale por la red UFPS.
 *  - Se verifica: enlace válido, celular vinculado, GPS dentro del campus (3 lecturas + detección de
 *    patrones de GPS falso), red de la universidad, clase en el horario y, opcional, selfie en vivo.
 *  - Conciliación cada 15 min, alertas y reporte diario por correo. Sin pantallas ni personal en los salones.
 *
 * Este archivo es el servidor (API + hoja). Hojas: Config, Horario, Docentes, Salones, Redes,
 * Festivos, Registros, Asistencia, Resumen.
 *
 * Se despliega desde GitHub (Actions). El secreto compartido con el Worker NO está en el repositorio:
 * el workflow lo escribe en zz_secreto.gs (variable SECRETO_WORKER_CI) a partir del secreto de GitHub.
 */

var DIAS = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];

// ---------------------------------------------------------------------------
// MENÚ
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Pulso · Asistencia')
    .addItem('1. Autorizar y verificar instalación', 'verificarInstalacion')
    .addItem('2. Generar enlaces personales', 'generarEnlaces')
    .addItem('3. Enviar enlaces por correo', 'enviarEnlaces')
    .addItem('4. Activar automatización', 'activarAutomatizacion')
    .addSeparator()
    .addItem('Actualizar redes detectadas', 'detectarRedes')
    .addItem('Enviar recordatorio de hoy a los docentes', 'recordatorioDiario')
    .addItem('Conciliar ahora', 'conciliar')
    .addItem('Enviar reporte de hoy', 'reporteDiario')
    .addToUi();
}

// ---------------------------------------------------------------------------
// API (solo acepta solicitudes firmadas por el Worker)
// ---------------------------------------------------------------------------
function doGet() {
  return json_({ ok: true, servicio: 'asistencia-docente', version: 3 });
}

function doPost(e) {
  var r;
  try {
    var sobre = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    r = procesar_(sobre, new Date());
  } catch (err) {
    r = { ok: false, tipo: 'error', titulo: 'Error del sistema', mensaje: String(err && err.message || err) };
  }
  return json_(r);
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** sobre = { payload: '<json del celular>', red: {ip, asn, org, ciudad, ts}, firma } */
function procesar_(sobre, ahora) {
  var red = verificarFirma_(sobre, ahora);
  if (!red) return { ok: false, tipo: 'error', titulo: 'Acceso no autorizado', mensaje: 'Abre tu enlace personal de asistencia.' };
  var p = JSON.parse(sobre.payload || '{}');
  if (p.accion === 'estado') return apiEstado_(p, ahora);
  if (p.accion === 'registrar') {
    var lock = LockService.getScriptLock();
    lock.waitLock(25000);
    try { return apiRegistrar_(p, red, ahora); } finally { lock.releaseLock(); }
  }
  return { ok: false, tipo: 'error', titulo: 'Acción no válida', mensaje: '' };
}

function secretoWorker_() {
  if (typeof SECRETO_WORKER_CI !== 'undefined' && SECRETO_WORKER_CI) return SECRETO_WORKER_CI;
  return PropertiesService.getScriptProperties().getProperty('SECRETO_WORKER');
}

function verificarFirma_(s, ahora) {
  var secreto = secretoWorker_();
  if (!secreto || !s || !s.red || !s.firma || typeof s.payload !== 'string') return null;
  var red = s.red;
  if (Math.abs(ahora.getTime() - Number(red.ts)) > 120000) return null;
  var base = [red.ip, red.asn, red.org, red.ciudad, red.ts, sha256Hex_(s.payload)].join('|');
  return hmacHex_(secreto, base) === s.firma ? red : null;
}

/** El celular consulta quién es el docente y qué clase tiene ahora. */
function apiEstado_(p, ahora) {
  var cfg = leerConfig_();
  var doc = docentePorToken_(p.token);
  if (!doc) return { ok: false, tipo: 'error', titulo: 'Enlace no válido', mensaje: 'Este enlace no está activo. Solicita tu enlace personal a la coordinación.' };
  var nowMin = aMinutos_(fmt_(ahora, cfg.tz, 'HH:mm'));
  var clases = clasesDeHoy_(doc.codigo, ahora, cfg);
  var actual = buscarClase_(clases, null, nowMin, cfg.minAntes);
  var siguiente = clases.filter(function (c) { return c.iniMin - cfg.minAntes > nowMin; })[0] || null;
  var resumen = function (c) { return c && { inicio: c.inicio, fin: c.fin, materia: c.materia, grupo: c.codMat, salon: c.salon, desde: hm_(c.iniMin - cfg.minAntes) }; };
  return { ok: true, docente: doc.nombre, actual: resumen(actual), siguiente: resumen(siguiente),
    exigeFoto: cfg.exigeFoto, minAntes: cfg.minAntes };
}

function apiRegistrar_(p, red, ahora) {
  var cfg = leerConfig_();
  var tz = cfg.tz;
  var fecha = fmt_(ahora, tz, 'yyyy-MM-dd');
  var hora = fmt_(ahora, tz, 'HH:mm:ss');
  var dia = diaDe_(ahora, tz);
  var nowMin = aMinutos_(fmt_(ahora, tz, 'HH:mm'));
  var disp = String(p.dispositivo || '').replace(/[^\w-]/g, '').slice(0, 64);
  var log = { fecha: fecha, hora: hora, codigo: '', docente: '', salon: '', lat: '', lng: '', acc: '', n: '', resultado: 'Rechazado',
    motivo: '', idClase: '', alertas: '', dist: '', disp: disp, ip: red.ip || '', org: red.org || '', ua: String(p.ua || '').slice(0, 160) };
  function rechazar(titulo, mensaje, tipo) {
    log.motivo = mensaje;
    escribirRegistro_(log);
    return { ok: false, tipo: 'error', motivo: tipo || '', titulo: titulo, mensaje: mensaje };
  }

  // 1. Enlace personal
  var doc = docentePorToken_(p.token);
  if (!doc) return rechazar('Enlace no válido', 'Este enlace no está activo. Solicita tu enlace personal a la coordinación.');
  log.codigo = doc.codigo; log.docente = doc.nombre;
  var alertas = [];

  // 2. Dispositivo vinculado (el enlace solo funciona en el celular del docente)
  if (!disp) return rechazar('Navegador no compatible', 'Activa las cookies / almacenamiento del navegador e inténtalo de nuevo.');
  if (!doc.dispositivo) {
    hoja_('Docentes').getRange(doc.fila, 7).setValue(disp);
  } else if (doc.dispositivo !== disp) {
    if (cfg.bloquearDispositivo) {
      return rechazar('Celular no autorizado', 'Tu enlace está vinculado a otro celular o navegador. Si cambiaste de celular, pide a la coordinación que lo libere.');
    }
    alertas.push('Dispositivo distinto al vinculado');
  }

  // 3. Clase en el horario
  var clase = buscarClase_(clasesDeHoy_(doc.codigo, ahora, cfg), null, nowMin, cfg.minAntes);
  if (!clase) return rechazar('Sin clase en este horario', 'No tienes una clase programada ahora. Puedes registrar desde ' +
    cfg.minAntes + ' min antes del inicio hasta el final de la clase.');
  log.idClase = clase.id; log.salon = clase.salon;
  var sal = leerSalones_()[clase.salon] || { exige: true, lat: null, lng: null, radio: null };

  // 4. Red de la universidad (IP real que ve Cloudflare; no se puede falsificar desde el celular)
  var enRed = ipEnRangos_(red.ip, redesAprobadas_());
  if (sal.exige && !enRed) {
    if (cfg.modoRed === 'EXIGIR') {
      return rechazar('Conéctate al WiFi de la universidad', 'Para registrar asistencia el celular debe estar conectado a la red WiFi de la UFPS (no datos móviles). Conéctate y vuelve a intentarlo.', 'red');
    }
    if (cfg.modoRed === 'ALERTA') alertas.push('Fuera de la red de la universidad (' + (red.org || red.ip) + ')');
  }

  // 5. Ubicación + heurísticas de GPS falso
  var gps = analizarGps_(p.muestras, sal, cfg);
  if (gps.mejor) {
    log.lat = gps.mejor.lat.toFixed(6); log.lng = gps.mejor.lng.toFixed(6); log.acc = Math.round(gps.mejor.acc);
    log.n = gps.n; log.dist = Math.round(gps.dist);
  }
  if (gps.error) return rechazar(gps.error.titulo, gps.error.mensaje, 'gps');
  alertas = alertas.concat(gps.alertas);
  if (gps.mejor && repiteCoordenadas_(doc.codigo, fecha, log.lat, log.lng)) alertas.push('Coordenadas idénticas a un registro de otro día');

  // 6. Foto (opcional)
  var foto = String(p.foto || '');
  if (cfg.exigeFoto && (!/^data:image\/jpeg;base64,/.test(foto) || foto.length < 3000)) {
    return rechazar('Foto requerida', 'Toma la foto con la cámara frontal antes de registrar.');
  }
  if (foto.length > 2000000) foto = '';

  // 7. Duplicado
  var hojaA = hoja_('Asistencia');
  var existente = buscarFilaAsistencia_(hojaA, fecha, clase.id);
  if (existente && existente.estado !== 'No registró') {
    log.resultado = 'Duplicado'; log.motivo = 'Ya existía un registro para esta clase';
    escribirRegistro_(log);
    return { ok: true, tipo: 'aviso', titulo: 'Ya estaba registrada', mensaje: clase.materia + ' (' + clase.inicio + '–' + clase.fin + ') ya tiene asistencia registrada hoy a las ' + existente.hora + '.' };
  }

  // 8. Mismo celular para dos docentes
  var otro = otroDocenteMismoDispositivo_(disp, doc.codigo, fecha);
  if (otro) alertas.push('Este celular registró hoy a otro docente (' + otro + ')');
  if (!sal.exige) alertas.push('Salón sin validación de ubicación');

  // 9. Guardar
  var urlFoto = '';
  if (foto) { try { urlFoto = guardarFoto_(foto, fecha, hora, clase.salon, doc.codigo); } catch (err) { alertas.push('No se pudo guardar la foto'); } }
  var retraso = Math.max(0, nowMin - clase.iniMin);
  var estado = retraso <= cfg.tolerancia ? 'A tiempo' : 'Tarde';
  var txt = alertas.join(' · ');
  escribirAsistencia_(hojaA, existente ? existente.fila : hojaA.getLastRow() + 1, [[fecha, dia, clase.id, clase.inicio, clase.fin,
    clase.codMat, clase.materia, doc.codigo, doc.nombre, clase.salon, hora, retraso, estado, enRed ? 'SI' : 'NO',
    Math.round(gps.dist), txt, urlFoto, '']]);
  log.resultado = 'Aceptado'; log.motivo = estado; log.alertas = txt;
  escribirRegistro_(log);

  if (txt && cfg.correo && cfg.alertaInmediata) {
    enviarCorreo_(cfg.correo, 'Asistencia docente: registro con alerta – ' + doc.nombre,
      doc.nombre + ' [' + doc.codigo + '] registró ' + clase.materia + ' (' + clase.salon + ') a las ' + hora + '.\n\nAlertas: ' + txt +
      '\nRed: ' + (red.org || '') + ' ' + (red.ip || '') + (urlFoto ? '\nFoto: ' + urlFoto : '') + '\n\nHoja: ' + SpreadsheetApp.getActive().getUrl());
  }
  return { ok: true, tipo: estado === 'A tiempo' ? 'ok' : 'aviso', titulo: 'Asistencia registrada',
    mensaje: clase.materia + ' · ' + clase.salon + '\n' + clase.inicio + '–' + clase.fin + ' · ' + dia + ' ' + fecha +
      '\nHora de registro: ' + hora + ' (' + estado + (retraso > 0 ? ', ' + retraso + ' min' : '') + ')' };
}

// ---------------------------------------------------------------------------
// RED DE LA UNIVERSIDAD
// ---------------------------------------------------------------------------
/** Rangos con "Aprobada = SI" en la hoja Redes (A rango, ..., F aprobada). */
function redesAprobadas_() {
  return hoja_('Redes').getDataRange().getDisplayValues().slice(1)
    .filter(function (f) { return f[0] && up_(f[5]) === 'SI'; })
    .map(function (f) { return String(f[0]).trim(); });
}

function ipEnRangos_(ip, rangos) {
  if (!ip) return false;
  for (var i = 0; i < rangos.length; i++) if (ipEnRango_(ip, rangos[i])) return true;
  return false;
}

function ipEnRango_(ip, rango) {
  var partes = String(rango).split('/');
  var a = bitsIp_(ip), b = bitsIp_(partes[0]);
  if (!a || !b || a.length !== b.length) return false;
  var n = partes[1] != null ? Number(partes[1]) : a.length;
  return a.slice(0, n) === b.slice(0, n);
}

/** IP (v4 o v6) como cadena de bits. */
function bitsIp_(ip) {
  ip = String(ip || '').trim();
  var bin = function (n, w) { return ('0000000000000000' + Number(n).toString(2)).slice(-w); };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
    var o = ip.split('.');
    if (o.some(function (x) { return Number(x) > 255; })) return null;
    return o.map(function (x) { return bin(x, 8); }).join('');
  }
  if (ip.indexOf(':') < 0) return null;
  var lados = ip.split('::');
  if (lados.length > 2) return null;
  var izq = lados[0] ? lados[0].split(':') : [], der = lados.length > 1 && lados[1] ? lados[1].split(':') : [];
  var faltan = 8 - izq.length - der.length;
  if (lados.length === 1 && faltan !== 0) return null;
  var g = izq.concat(new Array(Math.max(0, faltan)).fill('0'), der);
  if (g.length !== 8 || g.some(function (x) { return !/^[0-9a-fA-F]{1,4}$/.test(x); })) return null;
  return g.map(function (x) { return bin(parseInt(x, 16), 16); }).join('');
}

function prefijoDe_(ip) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return ip.split('.').slice(0, 3).join('.') + '.0/24';
  var b = bitsIp_(ip);
  if (!b) return '';
  var g = [];
  for (var i = 0; i < 3; i++) g.push(parseInt(b.slice(i * 16, i * 16 + 16), 2).toString(16));
  return g.join(':') + '::/48';
}

/**
 * Aprende redes: agrupa las conexiones de registros aceptados con GPS limpio dentro del campus.
 * Las redes que usan varios docentes distintos aparecen en la hoja Redes; la coordinación solo
 * escribe SI en "Aprobada" para la red de la universidad (no para operadores móviles).
 */
function detectarRedes() {
  var v = hoja_('Registros').getDataRange().getDisplayValues().slice(1);
  var mapa = {};
  v.forEach(function (f) {
    if (f[9] !== 'Aceptado' || !f[15] || /congeladas|irreal|saltos|idénticas/.test(f[12])) return;
    var pre = prefijoDe_(f[15]);
    if (!pre) return;
    var m = mapa[pre] = mapa[pre] || { org: f[16], docentes: {}, n: 0, ultima: '' };
    m.docentes[f[2]] = 1; m.n++; if (f[0] > m.ultima) m.ultima = f[0];
  });
  var sh = hoja_('Redes');
  var actuales = sh.getDataRange().getDisplayValues().slice(1);
  var idx = {};
  actuales.forEach(function (f, i) { if (f[0]) idx[f[0]] = i + 2; });
  Object.keys(mapa).forEach(function (pre) {
    var m = mapa[pre], fila = [pre, m.org, Object.keys(m.docentes).length, m.n, m.ultima];
    if (idx[pre]) sh.getRange(idx[pre], 1, 1, 5).setValues([fila]);
    else sh.getRange(sh.getLastRow() + 1, 1, 1, 6).setValues([fila.concat(['PENDIENTE'])]);
  });
}

// ---------------------------------------------------------------------------
// ANÁLISIS DE UBICACIÓN
// ---------------------------------------------------------------------------
function analizarGps_(muestrasIn, sal, cfg) {
  var r = { alertas: [], mejor: null, dist: 0, n: 0, error: null };
  var m = (Array.isArray(muestrasIn) ? muestrasIn : []).slice(0, 10).map(function (x) {
    return { lat: Number(x.lat), lng: Number(x.lng), acc: Number(x.acc), t: Number(x.t) };
  }).filter(function (x) { return isFinite(x.lat) && isFinite(x.lng) && isFinite(x.acc) && !(x.lat === 0 && x.lng === 0); });
  r.n = m.length;
  if (!m.length) { r.error = { titulo: 'Ubicación requerida', mensaje: 'Activa el GPS y permite el acceso a la ubicación.' }; return r; }
  var mejor = m.slice().sort(function (a, b) { return a.acc - b.acc; })[0];
  r.mejor = mejor;
  r.dist = distanciaMetros_(mejor.lat, mejor.lng, sal.lat != null ? sal.lat : cfg.lat, sal.lng != null ? sal.lng : cfg.lng);
  var radio = sal.radio != null ? sal.radio : cfg.radio;
  if (sal.exige) {
    if (m.length < cfg.minMuestras) { r.error = { titulo: 'Ubicación incompleta', mensaje: 'No se obtuvieron suficientes lecturas del GPS. Inténtalo de nuevo.' }; return r; }
    if (mejor.acc > cfg.precisionMax) { r.error = { titulo: 'Ubicación imprecisa', mensaje: 'La señal GPS es imprecisa (±' + Math.round(mejor.acc) + ' m). Acércate a una ventana e inténtalo de nuevo.' }; return r; }
    if (r.dist > radio) { r.error = { titulo: 'Fuera de la universidad', mensaje: 'Tu ubicación está a ' + Math.round(r.dist) + ' m del campus. Solo puedes registrar dentro de la universidad.' }; return r; }
  }
  if (m.length >= 3 && m.every(function (x) { return Math.abs(x.lat - m[0].lat) < 1e-7 && Math.abs(x.lng - m[0].lng) < 1e-7 && x.acc === m[0].acc; })) {
    r.alertas.push('Coordenadas congeladas (lecturas idénticas)');
  }
  if (m.every(function (x) { return x.acc < 2; })) r.alertas.push('Precisión GPS irreal (< 2 m)');
  for (var i = 1; i < m.length; i++) {
    var dt = Math.abs(m[i].t - m[i - 1].t) / 1000;
    if (dt > 0 && distanciaMetros_(m[i].lat, m[i].lng, m[i - 1].lat, m[i - 1].lng) / dt > 50) { r.alertas.push('Saltos de ubicación imposibles'); break; }
  }
  return r;
}

function repiteCoordenadas_(codigo, fecha, lat, lng) {
  var sh = hoja_('Registros');
  if (sh.getLastRow() < 2) return false;
  return sh.getRange(2, 1, sh.getLastRow() - 1, 10).getDisplayValues().some(function (f) {
    return f[2] === codigo && f[0] !== fecha && f[9] === 'Aceptado' && f[5] === lat && f[6] === lng;
  });
}

function otroDocenteMismoDispositivo_(disp, codigo, fecha) {
  var sh = hoja_('Registros');
  if (sh.getLastRow() < 2) return '';
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 15).getDisplayValues();
  for (var i = v.length - 1; i >= 0; i--) if (v[i][0] === fecha && v[i][9] === 'Aceptado' && v[i][14] === disp && v[i][2] !== codigo) return v[i][3];
  return '';
}

// ---------------------------------------------------------------------------
// FOTO EN DRIVE
// ---------------------------------------------------------------------------
function carpetaEvidencias_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('CARPETA_EVIDENCIAS');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) { /* se recrea */ } }
  var f = DriveApp.createFolder('Evidencias asistencia docente');
  props.setProperty('CARPETA_EVIDENCIAS', f.getId());
  return f;
}

function guardarFoto_(dataUrl, fecha, hora, salon, codigo) {
  var raiz = carpetaEvidencias_(), it = raiz.getFoldersByName(fecha);
  var dir = it.hasNext() ? it.next() : raiz.createFolder(fecha);
  var nombre = fecha + '_' + hora.replace(/:/g, '') + '_' + salon + '_' + codigo + '.jpg';
  return dir.createFile(Utilities.newBlob(Utilities.base64Decode(dataUrl.split(',')[1]), 'image/jpeg', nombre)).getUrl();
}

// ---------------------------------------------------------------------------
// HORARIO
// ---------------------------------------------------------------------------
function clasesDeHoy_(codigo, ahora, cfg) {
  var dia = diaDe_(ahora, cfg.tz);
  return leerHorario_().filter(function (c) { return c.codDoc === codigo && c.dia === dia; })
    .sort(function (a, b) { return a.iniMin - b.iniMin; });
}

function buscarClase_(clases, salon, nowMin, minAntes) {
  var v = clases.filter(function (c) { return nowMin >= c.iniMin - minAntes && nowMin < c.finMin; });
  v.sort(function (a, b) { return Math.abs(nowMin - a.iniMin) - Math.abs(nowMin - b.iniMin); });
  return v[0] || null;
}

// ---------------------------------------------------------------------------
// CONCILIACIÓN Y REPORTE
// ---------------------------------------------------------------------------
function conciliar() { conciliar_(new Date(), false); }

function conciliar_(ahora, final) {
  var cfg = leerConfig_();
  var fecha = fmt_(ahora, cfg.tz, 'yyyy-MM-dd');
  if (!diaHabil_(fecha, cfg)) return [];
  var dia = diaDe_(ahora, cfg.tz), nowMin = aMinutos_(fmt_(ahora, cfg.tz, 'HH:mm'));
  var lock = LockService.getScriptLock();
  lock.waitLock(25000);
  var nuevos = [];
  try {
    var hojaA = hoja_('Asistencia'), existentes = idsAsistencia_(hojaA, fecha);
    leerHorario_().forEach(function (c) {
      if (c.dia !== dia || existentes[c.id]) return;
      if (!final && nowMin < c.iniMin + cfg.tolerancia) return;
      nuevos.push([fecha, dia, c.id, c.inicio, c.fin, c.codMat, c.materia, c.codDoc, c.docente, c.salon, '', '', 'No registró', '', '', '', '', '']);
    });
    if (nuevos.length) escribirAsistencia_(hojaA, hojaA.getLastRow() + 1, nuevos);
  } finally { lock.releaseLock(); }
  if (nuevos.length && !final && cfg.alertas && cfg.correo) {
    enviarCorreo_(cfg.correo, 'Asistencia docente: ' + nuevos.length + ' clase(s) sin registro – ' + fecha,
      'Clases sin registro (' + fecha + '):\n\n' + nuevos.map(function (f) { return '• ' + f[3] + '–' + f[4] + '  ' + f[9] + '  ' + f[6] + '  —  ' + f[8]; }).join('\n') +
      '\n\nSi el docente registra después, cambia automáticamente a "Tarde".');
  }
  return nuevos;
}

function reporteDiario() {
  var ahora = new Date(), cfg = leerConfig_(), fecha = fmt_(ahora, cfg.tz, 'yyyy-MM-dd');
  detectarRedes();
  if (!diaHabil_(fecha, cfg)) return;
  conciliar_(ahora, true);
  if (!cfg.correo) return;
  var datos = hoja_('Asistencia').getDataRange().getDisplayValues().slice(1).filter(function (f) { return f[0] === fecha; });
  if (!datos.length) return;
  var c = { 'A tiempo': 0, 'Tarde': 0, 'No registró': 0 };
  datos.forEach(function (f) { c[f[12]] = (c[f[12]] || 0) + 1; });
  var linea = function (f) { return '• ' + f[3] + '–' + f[4] + '  ' + f[9] + '  ' + f[6] + '  —  ' + f[8]; };
  var alerta = datos.filter(function (f) { return f[15]; }), faltas = datos.filter(function (f) { return f[12] === 'No registró'; });
  var pend = hoja_('Redes').getDataRange().getDisplayValues().slice(1).filter(function (f) { return f[0] && up_(f[5]) === 'PENDIENTE' && Number(f[2]) >= 3; });
  enviarCorreo_(cfg.correo, 'Reporte diario de asistencia docente – ' + fecha,
    'Resumen ' + fecha + '\n\nClases: ' + datos.length + '\nA tiempo: ' + c['A tiempo'] + '\nTarde: ' + c['Tarde'] + '\nNo registró: ' + c['No registró'] +
    '\nCon alerta: ' + alerta.length + '\nCumplimiento: ' + Math.round(100 * (c['A tiempo'] + c['Tarde']) / datos.length) + '%\n\n' +
    (alerta.length ? 'REVISAR:\n' + alerta.map(function (f) { return linea(f) + '\n   ' + f[15] + (f[16] ? '\n   Foto: ' + f[16] : ''); }).join('\n') + '\n\n' : '') +
    (faltas.length ? 'SIN REGISTRO:\n' + faltas.map(linea).join('\n') + '\n\n' : '') +
    (pend.length ? 'REDES POR APROBAR (hoja Redes): ' + pend.map(function (f) { return f[0] + ' ' + f[1] + ' (' + f[2] + ' docentes)'; }).join(', ') + '\n\n' : '') +
    'Hoja: ' + SpreadsheetApp.getActive().getUrl());
}

// ---------------------------------------------------------------------------
// HERRAMIENTAS DE CONFIGURACIÓN
// ---------------------------------------------------------------------------
/** Primer paso tras el despliegue: pide los permisos (hoja, Drive, correo) y revisa la configuración. */
function verificarInstalacion() {
  var cfg = leerConfig_(), faltan = [];
  if (!secretoWorker_()) faltan.push('Secreto del Worker (vuelve a ejecutar el workflow "Desplegar" en GitHub)');
  if (!cfg.urlPagina && !cfg.urlWorker) faltan.push('Config → "URL de la página (GitHub Pages)" (aparece en el resumen del workflow en GitHub)');
  if (!cfg.correo) faltan.push('Config → "Correo del coordinador"');
  var sinCorreo = hoja_('Docentes').getDataRange().getDisplayValues().slice(1).filter(function (f) { return f[0] && !f[3]; }).length;
  if (sinCorreo) faltan.push(sinCorreo + ' docentes sin correo en la hoja Docentes');
  DriveApp.getRootFolder(); MailApp.getRemainingDailyQuota();
  avisar_(faltan.length ? 'Permisos autorizados. Falta completar:\n\n• ' + faltan.join('\n• ') : 'Todo listo. Continúa con el menú 2 (Generar enlaces personales).');
}

function generarEnlaces() {
  var cfg = leerConfig_();
  var base = basePagina_(cfg);
  if (!base) throw new Error('Escribe primero en Config la "URL de la página (GitHub Pages)".');
  var sh = hoja_('Docentes'), n = sh.getLastRow() - 1;
  if (n < 1) return;
  var v = sh.getRange(2, 1, n, 8).getDisplayValues();
  var tokens = v.map(function (f) { return [f[5] || (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').slice(0, 32)]; });
  sh.getRange(2, 6, n, 1).setNumberFormat('@').setValues(tokens);
  sh.getRange(2, 8, n, 1).setValues(tokens.map(function (t) { return [base + '/?d=' + t[0]]; }));
  avisar_('Enlaces generados (columna H). Envíalos con la opción 3 o compártelos uno a uno. Mantén la hoja privada.');
}

function enviarEnlaces() {
  var cfg = leerConfig_(), env = 0, sin = [];
  hoja_('Docentes').getDataRange().getDisplayValues().slice(1).forEach(function (f) {
    if (!f[0] || up_(f[4]) === 'NO') return;
    if (!f[3] || !f[7]) { sin.push(f[1]); return; }
    enviarCorreo_(f[3], 'Tu enlace personal de Pulso (asistencia docente)',
      'Hola ' + f[1] + ',\n\nEste es tu enlace personal para registrar asistencia:\n' + f[7] +
      '\n\nCómo usarlo:\n1. Ábrelo en tu celular y guárdalo en la pantalla de inicio (Chrome: ⋮ → Agregar a pantalla principal; Safari: Compartir → Agregar a inicio).\n' +
      '2. Cuando estés en el salón, conéctate al WiFi de la universidad, activa la ubicación y abre el enlace.\n3. Toca "Registrar asistencia".\n\n' +
      'El enlace queda vinculado al primer celular donde lo abras. No lo compartas.' + (cfg.correo ? '\n\nDudas: ' + cfg.correo : ''));
    env++;
  });
  avisar_(env + ' correos enviados.' + (sin.length ? ' Sin correo o sin enlace: ' + sin.join(', ') : ''));
}

function activarAutomatizacion() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (['conciliar', 'reporteDiario', 'recordatorioDiario'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('conciliar').timeBased().everyMinutes(15).create();
  ScriptApp.newTrigger('reporteDiario').timeBased().atHour(22).nearMinute(30).everyDays(1).create();
  // Google ejecuta los disparadores diarios dentro de una ventana (~±15 min): se programa a las 5:30
  // para que el recordatorio llegue antes de las clases de las 6:00.
  ScriptApp.newTrigger('recordatorioDiario').timeBased().atHour(5).nearMinute(30).everyDays(1).create();
  avisar_('Automatización activada:\n• Recordatorio a cada docente con clase, entre 5:15 y 5:45 a. m.\n• Conciliación cada 15 min.\n• Reporte diario hacia las 10:30 p. m.');
}

/**
 * Recordatorio de la mañana: a cada docente que tiene clase HOY le llega un correo con sus clases
 * (hora, salón, materia) y su enlace personal. Se omite en festivos y fuera de las fechas de control.
 */
function recordatorioDiario() {
  var cfg = leerConfig_(), ahora = new Date();
  if (!cfg.recordatorio) return 0;
  var fecha = fmt_(ahora, cfg.tz, 'yyyy-MM-dd');
  if (!diaHabil_(fecha, cfg)) return 0;
  var base = basePagina_(cfg);
  if (!base) throw new Error('Falta Config → "URL de la página (GitHub Pages)".');
  var dia = diaDe_(ahora, cfg.tz);
  var porDocente = {};
  leerHorario_().forEach(function (c) { if (c.dia === dia) (porDocente[c.codDoc] = porDocente[c.codDoc] || []).push(c); });
  var enviados = 0, sinCupo = [];
  hoja_('Docentes').getDataRange().getDisplayValues().slice(1).forEach(function (f) {
    var cod = normalizarCodigo_(f[0]), correo = String(f[3] || '').trim(), clave = String(f[5] || '').trim();
    var clases = porDocente[cod];
    if (!cod || up_(f[4]) === 'NO' || !correo || !clave || !clases) return;
    if (MailApp.getRemainingDailyQuota() < 3) { sinCupo.push(f[1]); return; }
    clases.sort(function (a, b) { return a.iniMin - b.iniMin; });
    var lista = clases.map(function (c) { return '• ' + c.inicio + '–' + c.fin + '  ' + c.salon + '  ' + c.materia + ' (' + c.codMat + ')'; }).join('\n');
    var nombre = String(f[1]).split(' ').slice(-2).join(' ');
    enviarCorreo_(correo, 'Pulso · Tus clases de hoy, ' + dia.toLowerCase() + ' ' + fecha,
      'Hola ' + nombre + ',\n\nHoy tienes ' + (clases.length === 1 ? 'esta clase' : 'estas clases') + ':\n' + lista +
      '\n\nRegistra tu asistencia al llegar al salón (desde ' + cfg.minAntes + ' minutos antes del inicio):\n' +
      base + '/?d=' + clave +
      '\n\nRecuerda: conectado al WiFi de la UFPS y con la ubicación activada. Usa siempre el mismo celular.');
    enviados++;
  });
  if (sinCupo.length && cfg.correo) {
    MailApp.sendEmail(cfg.correo, 'Pulso: cupo diario de correos agotado',
      'No se pudo enviar el recordatorio a: ' + sinCupo.join(', ') + '. Gmail permite ~100 destinatarios por día en cuentas personales.');
  }
  Logger.log('Recordatorios enviados: ' + enviados);
  return enviados;
}

/** Dirección pública de la página del docente: GitHub Pages (preferida) o el Worker. Sin "/" final. */
function basePagina_(cfg) {
  return String(cfg.urlPagina || cfg.urlWorker || '').trim().replace(/\/+$/, '').replace(/\/index\.html$/, '');
}

// ---------------------------------------------------------------------------
// LECTURA / ESCRITURA
// ---------------------------------------------------------------------------
function hoja_(n) { var sh = SpreadsheetApp.getActive().getSheetByName(n); if (!sh) throw new Error('Falta la hoja "' + n + '".'); return sh; }

function leerConfig_() {
  var m = {};
  hoja_('Config').getDataRange().getValues().forEach(function (f) { if (f[0] !== '') m[String(f[0]).trim()] = f[1]; });
  var num = function (k, d) { var x = Number(m[k]); return m[k] !== '' && m[k] != null && isFinite(x) ? x : d; };
  var si = function (k, d) { var x = up_(m[k]); return x ? x === 'SI' : d; };
  var modo = up_(m['Validación de red WiFi (NO/ALERTA/EXIGIR)']);
  return {
    tz: Session.getScriptTimeZone() || 'America/Bogota',
    urlWorker: String(m['URL del Worker'] || '').trim(),
    urlPagina: String(m['URL de la página (GitHub Pages)'] || '').trim(),
    correo: String(m['Correo del coordinador'] || '').trim(),
    modoRed: ['NO', 'ALERTA', 'EXIGIR'].indexOf(modo) >= 0 ? modo : 'ALERTA',
    lat: num('Latitud del campus', 7.898115), lng: num('Longitud del campus', -72.488703),
    radio: num('Radio permitido (m)', 300), precisionMax: num('Precisión GPS máxima (m)', 100),
    minMuestras: num('Lecturas GPS mínimas', 3),
    exigeFoto: si('Exigir foto en vivo (SI/NO)', false),
    bloquearDispositivo: si('Bloquear si cambia el celular (SI/NO)', true),
    alertaInmediata: si('Correo inmediato por alertas (SI/NO)', true),
    minAntes: num('Minutos antes del inicio para registrar', 15), tolerancia: num('Tolerancia de llegada (min)', 10),
    alertas: si('Enviar alertas de no registro (SI/NO)', true),
    recordatorio: si('Recordatorio diario a docentes (SI/NO)', true),
    inicio: fechaIso_(m['Fecha inicio de control']), fin: fechaIso_(m['Fecha fin de control'])
  };
}

function leerHorario_() {
  var v = hoja_('Horario').getDataRange().getDisplayValues(), h = v[0].map(function (x) { return String(x).trim(); });
  var ix = function (n) { var i = h.indexOf(n); if (i < 0) throw new Error('Falta la columna "' + n + '" en Horario'); return i; };
  var I = { id: ix('ID clase'), dia: ix('Día'), ini: ix('Hora inicio'), fin: ix('Hora fin'), cm: ix('Código materia'), mat: ix('Materia'), cd: ix('Código docente'), doc: ix('Docente'), sal: ix('Salón') };
  return v.slice(1).filter(function (f) { return f[I.id]; }).map(function (f) {
    var ini = hhmm_(f[I.ini]), fin = hhmm_(f[I.fin]);
    return { id: f[I.id], dia: f[I.dia].trim(), inicio: ini, fin: fin, iniMin: aMinutos_(ini), finMin: aMinutos_(fin), codMat: f[I.cm],
      materia: f[I.mat], codDoc: normalizarCodigo_(f[I.cd]), docente: f[I.doc], salon: up_(f[I.sal]) };
  });
}

/** Docentes: A código, B nombre, C categoría, D correo, E activo, F clave del enlace, G celular vinculado, H enlace. */
function docentePorToken_(token) {
  token = String(token || '').trim();
  if (token.length < 20) return null;
  var v = hoja_('Docentes').getDataRange().getDisplayValues();
  for (var i = 1; i < v.length; i++) {
    var f = v[i];
    if (f[5] && f[5] === token && up_(f[4]) !== 'NO') {
      return { codigo: normalizarCodigo_(f[0]), nombre: f[1], dispositivo: String(f[6] || '').trim(), fila: i + 1 };
    }
  }
  return null;
}

/** Salones: A salón, B exige ubicación, C lat, D lng, E radio. */
function leerSalones_() {
  var m = {};
  hoja_('Salones').getDataRange().getDisplayValues().slice(1).forEach(function (f) {
    var s = up_(f[0]);
    if (!s) return;
    var n = function (x) { var y = parseFloat(String(x).replace(',', '.')); return isFinite(y) ? y : null; };
    m[s] = { exige: up_(f[1]) !== 'NO', lat: n(f[2]), lng: n(f[3]), radio: n(f[4]) };
  });
  return m;
}

function diaHabil_(fecha, cfg) {
  if (cfg.inicio && fecha < cfg.inicio) return false;
  if (cfg.fin && fecha > cfg.fin) return false;
  return hoja_('Festivos').getDataRange().getValues().slice(1).map(function (f) { return fechaIso_(f[0]); }).indexOf(fecha) === -1;
}

function idsAsistencia_(sh, fecha) {
  var m = {};
  if (sh.getLastRow() >= 2) sh.getRange(2, 1, sh.getLastRow() - 1, 3).getDisplayValues().forEach(function (f) { if (f[0] === fecha) m[f[2]] = true; });
  return m;
}

/** Asistencia (A–R): ... L hora registro, M estado... ver FMT. */
function buscarFilaAsistencia_(sh, fecha, id) {
  if (sh.getLastRow() < 2) return null;
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, 13).getDisplayValues();
  for (var i = 0; i < v.length; i++) if (v[i][0] === fecha && v[i][2] === id) return { fila: i + 2, estado: v[i][12], hora: v[i][10] };
  return null;
}

/**
 * Asistencia: Fecha, Día, ID clase, Hora inicio, Hora fin, Código materia, Materia, Código docente, Docente, Salón,
 * Hora registro, Minutos de retraso, Estado, En red UFPS, Distancia (m), Alertas, Foto, Revisión coordinador.
 */
var FMT_ASISTENCIA = ['@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '@', '0', '@', '@', '0', '@', '@', '@'];
function escribirAsistencia_(sh, fila, filas) {
  var vals = filas.map(function (f) { return f.map(function (x, j) { return FMT_ASISTENCIA[j] === '@' ? String(x) : x; }); });
  sh.getRange(fila, 1, filas.length, FMT_ASISTENCIA.length).setNumberFormats(filas.map(function () { return FMT_ASISTENCIA; })).setValues(vals);
}

/**
 * Registros (A–R): Fecha, Hora, Código, Docente, Salón, Latitud, Longitud, Precisión, Lecturas GPS, Resultado,
 * Motivo, ID clase, Alertas, Distancia, Celular, IP, Red, Navegador.
 */
function escribirRegistro_(l) {
  var fila = [l.fecha, l.hora, l.codigo, l.docente, l.salon, l.lat, l.lng, l.acc, l.n, l.resultado, l.motivo, l.idClase, l.alertas, l.dist, l.disp, l.ip, l.org, l.ua];
  var sh = hoja_('Registros');
  sh.getRange(sh.getLastRow() + 1, 1, 1, fila.length).setNumberFormat('@').setValues([fila.map(String)]);
}

// ---------------------------------------------------------------------------
// UTILIDADES
// ---------------------------------------------------------------------------
function hmacHex_(clave, msg) { return hexBytes_(Utilities.computeHmacSha256Signature(msg, clave, Utilities.Charset.UTF_8)); }
function sha256Hex_(s) { return hexBytes_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)); }
function hexBytes_(b) { return b.map(function (x) { return ('0' + (x & 0xff).toString(16)).slice(-2); }).join(''); }
function fmt_(d, tz, p) { return Utilities.formatDate(d, tz, p); }
function diaDe_(d, tz) { return DIAS[Number(fmt_(d, tz, 'u')) - 1]; }
function up_(x) { return String(x == null ? '' : x).trim().toUpperCase(); }
function hm_(m) { m = Math.max(0, m); return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); }
function fechaIso_(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') return fmt_(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var s = String(v).trim(), m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  return m ? m[3] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[1]).slice(-2) : s;
}
function normalizarCodigo_(c) { var s = String(c == null ? '' : c).replace(/\D/g, ''); return !s ? '' : (s.length < 5 ? ('00000' + s).slice(-5) : s); }
function hhmm_(v) { var m = String(v).trim().match(/^(\d{1,2}):(\d{2})/); return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : String(v).trim(); }
function aMinutos_(h) { var p = String(h).split(':'); return Number(p[0]) * 60 + Number(p[1]); }
function distanciaMetros_(a1, o1, a2, o2) {
  var R = 6371000, r = Math.PI / 180, dA = (a2 - a1) * r, dO = (o2 - o1) * r;
  var x = Math.sin(dA / 2) * Math.sin(dA / 2) + Math.cos(a1 * r) * Math.cos(a2 * r) * Math.sin(dO / 2) * Math.sin(dO / 2);
  return 2 * R * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
// ---------------------------------------------------------------------------
// CORREOS CON IDENTIDAD UFPS (rojo institucional + franja de la bandera)
// ---------------------------------------------------------------------------
var COLORES_UFPS = { rojo: '#E2031A', negro: '#111111', naranja: '#FF9900', verde: '#66CC33', gris: '#5B5E63' };

function enviarCorreo_(para, asunto, texto) {
  var base = '';
  try { base = basePagina_(leerConfig_()); } catch (e) { /* sin config */ }
  if (MailApp.getRemainingDailyQuota() < 1) { Logger.log('Sin cupo de correo: ' + asunto); return; }
  MailApp.sendEmail(para, asunto, texto, { name: 'Pulso · Asistencia docente UFPS', htmlBody: correoHtml_(asunto, texto, base) });
}

function correoHtml_(asunto, texto, base) {
  var c = COLORES_UFPS;
  var esc = function (t) { return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
  var cuerpo = esc(texto)
    .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" style="color:' + c.rojo + ';word-break:break-all">$1</a>')
    .replace(/^([A-ZÁÉÍÓÚÑ][A-ZÁÉÍÓÚÑ ()]+:)$/gm, '<b style="color:' + c.rojo + '">$1</b>')
    .replace(/\n/g, '<br>');
  var logo = base ? '<img src="' + base + '/assets/ufps.png" width="48" height="48" alt="UFPS" style="display:block;border:0">' : '';
  var pie = base ? '<img src="' + base + '/assets/ing-electronica.png" height="44" alt="Ingeniería Electrónica – UFPS" style="vertical-align:middle;border:0;border-radius:6px">' +
    '&nbsp;&nbsp;<img src="' + base + '/assets/acreditado.png" height="40" alt="Acreditado" style="vertical-align:middle;border:0">' : '';
  return '<div style="background:#F5F5F7;padding:16px 0;font-family:Arial,Helvetica,sans-serif">' +
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:640px;margin:0 auto;background:#fff;border-radius:10px;overflow:hidden;border:1px solid #E2E3E6">' +
    '<tr><td style="background:' + c.rojo + ';padding:14px 18px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>' +
    (logo ? '<td style="padding-right:12px">' + logo + '</td>' : '') +
    '<td style="color:#fff"><div style="font-size:11px;opacity:.9">Pulso · Departamento de Electricidad y Electrónica · UFPS</div>' +
    '<div style="font-size:17px;font-weight:bold;margin-top:2px">' + esc(asunto) + '</div></td></tr></table></td></tr>' +
    '<tr><td style="height:4px;background:' + c.negro + '"></td></tr><tr><td style="height:4px;background:' + c.naranja + '"></td></tr><tr><td style="height:4px;background:' + c.verde + '"></td></tr>' +
    '<tr><td style="padding:18px;font-size:14px;line-height:1.55;color:' + c.negro + '">' + cuerpo + '</td></tr>' +
    (pie ? '<tr><td style="padding:10px 18px 16px;border-top:1px solid #EEEFF1;text-align:center">' + pie + '</td></tr>' : '') +
    '</table></div>';
}

function avisar_(msg) { try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); } }
