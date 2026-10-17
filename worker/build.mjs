// Compila las dos salidas a partir de la página que está en la RAÍZ del repositorio
// (index.html, config.js, manifest.webmanifest y assets/):
//   worker/dist/worker.js  → Cloudflare Worker (API + copia de la página, con config.js = '/api')
//   dist-pagina/           → sitio para GitHub Pages (solo la página, sin el resto del repositorio)
// Variable opcional API_URL: URL de la API del Worker para config.js de GitHub Pages.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_PAGINA = path.join(RAIZ, 'dist-pagina');
const archivos = ['index.html', 'config.js', 'manifest.webmanifest',
  ...fs.readdirSync(path.join(RAIZ, 'assets')).filter((f) => f.endsWith('.png')).sort().map((f) => 'assets/' + f)];

// 1. Worker: incrusta la página; dentro del Worker la API está en el mismo dominio
const incrustados = {};
for (const f of archivos) {
  const buf = fs.readFileSync(path.join(RAIZ, f));
  incrustados[f] = f.endsWith('.png') ? { b64: buf.toString('base64') } : { texto: buf.toString('utf8') };
}
incrustados['config.js'] = { texto: "window.PULSO_API = '/api';\n" };
const plantilla = fs.readFileSync(path.join(RAIZ, 'worker', 'src', 'worker.plantilla.js'), 'utf8');
fs.mkdirSync(path.join(RAIZ, 'worker', 'dist'), { recursive: true });
fs.writeFileSync(path.join(RAIZ, 'worker', 'dist', 'worker.js'), plantilla.replace('__ARCHIVOS__', () => JSON.stringify(incrustados)));
console.log('worker/dist/worker.js listo (' + archivos.length + ' archivos incrustados)');

// 2. GitHub Pages: solo la página (el resto del repositorio no se publica)
fs.rmSync(DIST_PAGINA, { recursive: true, force: true });
for (const f of [...archivos, '.nojekyll']) {
  fs.mkdirSync(path.dirname(path.join(DIST_PAGINA, f)), { recursive: true });
  fs.copyFileSync(path.join(RAIZ, f), path.join(DIST_PAGINA, f));
}
if (process.env.API_URL) {
  fs.writeFileSync(path.join(DIST_PAGINA, 'config.js'), '// Generado por el workflow "Desplegar". No editar.\nwindow.PULSO_API = ' + JSON.stringify(process.env.API_URL) + ';\n');
}
console.log('dist-pagina/ listo (API: ' + (process.env.API_URL || 'la de config.js') + ')');
