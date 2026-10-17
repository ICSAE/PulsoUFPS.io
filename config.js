// ─────────────────────────────────────────────────────────────────────────────
// Pulso · Dirección del puente (Cloudflare Worker)
//
// • Si publicas con el workflow "Desplegar" (GitHub Pages → Source: GitHub Actions),
//   este archivo se reemplaza solo con la URL correcta. No hay que tocarlo.
// • Si publicas GitHub Pages "Deploy from a branch", cambia la línea de abajo por la
//   URL de tu Worker (aparece en el resumen del workflow o en Cloudflare), terminada en /api.
// ─────────────────────────────────────────────────────────────────────────────
window.PULSO_API = 'https://pulso-ufps.TU-SUBDOMINIO.workers.dev/api';
