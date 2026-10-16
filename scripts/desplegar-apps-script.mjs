// Sube el código a Apps Script y actualiza SIEMPRE la misma implementación de aplicación web,
// para que la URL /exec no cambie entre despliegues.
// Variables de entorno: SCRIPT_ID, WORKER_SECRETO (y ~/.clasprc.json ya escrito por el workflow).
import fs from 'fs';
import { execFileSync } from 'child_process';

const DESCRIPCION = 'asistencia-produccion';
const { SCRIPT_ID, WORKER_SECRETO, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;
if (!SCRIPT_ID) throw new Error('Falta el secreto SCRIPT_ID');
if (!WORKER_SECRETO || WORKER_SECRETO.length < 32) throw new Error('Falta el secreto WORKER_SECRETO (mínimo 32 caracteres)');

// El secreto se inyecta como archivo de código (no se guarda en el repositorio)
fs.writeFileSync('apps-script/zz_secreto.gs',
  '// Generado por GitHub Actions. No editar.\nvar SECRETO_WORKER_CI = ' + JSON.stringify(WORKER_SECRETO) + ';\n');
fs.writeFileSync('.clasp.json', JSON.stringify({ scriptId: SCRIPT_ID, rootDir: 'apps-script' }, null, 2));

const clasp = (...args) => execFileSync('npx', ['--no-install', 'clasp', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
const jsonDe = (txt) => {
  const i = txt.search(/[[{]/);
  if (i < 0) throw new Error('Respuesta inesperada de clasp:\n' + txt);
  return JSON.parse(txt.slice(i));
};

console.log('→ Subiendo código…');
console.log(clasp('push', '--force'));

console.log('→ Buscando la implementación de producción…');
const lista = jsonDe(clasp('--json', 'list-deployments'));
const existente = lista.find((d) => d.description === DESCRIPCION);

console.log(existente ? '→ Actualizando ' + existente.deploymentId : '→ Creando la implementación (primera vez)');
const args = ['--json', 'create-deployment', '-d', DESCRIPCION];
if (existente) args.push('-i', existente.deploymentId);
const dep = jsonDe(clasp(...args));
const url = 'https://script.google.com/macros/s/' + dep.deploymentId + '/exec';
console.log('✔ Implementación ' + dep.deploymentId + ' versión ' + dep.versionNumber + '\n  ' + url);

if (GITHUB_OUTPUT) fs.appendFileSync(GITHUB_OUTPUT, `url=${url}\ndeployment_id=${dep.deploymentId}\n`);
if (GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(GITHUB_STEP_SUMMARY, `### Apps Script\n- Versión desplegada: **${dep.versionNumber}**\n- Aplicación web: \`${url}\`\n` +
    (existente ? '' : '- Primera implementación creada. **Abre la hoja → menú Pulso · Asistencia → 1. Autorizar** para conceder los permisos.\n') + '\n');
}
fs.rmSync('apps-script/zz_secreto.gs');
