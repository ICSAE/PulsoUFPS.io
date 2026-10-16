// Genera worker/dist/worker.js incrustando la página del docente (src/registro.html).
import fs from 'fs';
const dir = new URL('.', import.meta.url);
const html = fs.readFileSync(new URL('src/registro.html', dir), 'utf8');
const plantilla = fs.readFileSync(new URL('src/worker.plantilla.js', dir), 'utf8');
const assets = {};
for (const f of fs.readdirSync(new URL('src/assets/', dir)).filter((f) => f.endsWith('.png')).sort()) {
  assets[f] = fs.readFileSync(new URL('src/assets/' + f, dir)).toString('base64');
}
fs.mkdirSync(new URL('dist/', dir), { recursive: true });
fs.writeFileSync(new URL('dist/worker.js', dir), plantilla
  .replace('__HTML__', () => JSON.stringify(html))
  .replace('__ASSETS__', () => JSON.stringify(assets, null, 0)));
console.log('Recursos incrustados: ' + Object.keys(assets).join(', '));
console.log('worker/dist/worker.js listo');
