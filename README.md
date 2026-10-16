# Pulso · Asistencia docente UFPS

**Pulso** es el registro automático de asistencia docente del **Departamento de Electricidad y Electrónica** de la Universidad Francisco de Paula Santander.
En electrónica, un *pulso* es la señal que marca que algo ocurrió: cada registro es el pulso de una clase dictada.
Cada docente abre **su enlace personal** en el salón, conectado al **WiFi de la universidad**, y toca *Registrar*.
Sin pantallas, sin personal en los salones.

Todo se ejecuta desde este repositorio: cada cambio en `main` se **prueba** y se **despliega solo** en Google Apps Script y Cloudflare.

```
Celular del docente ──► Cloudflare Worker ──(IP real + firma)──► Apps Script ──► Google Sheets
   (enlace personal)     (página + proxy)                         (validación)     (horario, registros,
                                                                                    asistencia, reportes)
```

## Qué valida cada registro

| Capa | Qué detiene |
|---|---|
| **Red WiFi UFPS** (IP real vista por Cloudflare) | GPS falso desde la casa: la conexión no sale por la red de la universidad |
| **GPS**: 3 lecturas, precisión, radio del campus, patrones de simulador | Registrar fuera del campus; apps de ubicación falsa |
| **Celular vinculado** al primer uso | Reenviar el enlace a otra persona |
| **Horario**: solo en la franja de su clase | Registrar a otra hora |
| **Firma HMAC** Worker → Apps Script | Saltarse el Worker llamando directo al servidor |
| **Foto en vivo** (opcional) | Prestar el celular |

## Identidad visual UFPS

| Uso | Color |
|---|---|
| Rojo institucional (encabezados, botones, salón) | `#E2031A` |
| Bandera – negro | `#000000` / texto `#111111` |
| Bandera – naranja (pendiente, avisos) | `#FF9900` |
| Bandera – verde (confirmado) | `#66CC33` |

- **Página del docente**: encabezado rojo con el logo UFPS, franja de la bandera, y al pie los logos de Ingeniería Electrónica y Programa acreditado; el texto institucional es el del Departamento de Electricidad y Electrónica.
- **Ícono del celular**: al agregarla a la pantalla de inicio aparece como **Pulso UFPS** con el logo UFPS (`/manifest.webmanifest`).
- **Correos** (enlaces, alertas, reporte diario): mismo encabezado y franja tricolor.
- **Hoja**: encabezados rojos, logos, franja de la bandera, pestañas de color y semáforo de cumplimiento.
- Logos originales en `marca/`; versiones optimizadas para la web en `worker/src/assets/` (se incrustan en el Worker al compilar).

## Estructura

```
apps-script/          Servidor (Code.gs + appsscript.json) → se sube con clasp
marca/                Logos UFPS, Ingeniería Electrónica, Acreditado y bandera
worker/               Cloudflare Worker: página del docente (src/registro.html) + proxy
hoja/                 Plantilla de la hoja de cálculo (subirla a Google Drive una vez)
herramientas/         Datos del horario y generador de la hoja (python3 herramientas/generar_hoja.py)
test/                 Prueba de punta a punta (21 casos, incluye ataques)
scripts/              configurar.sh (una vez, en Codespaces) y despliegue de Apps Script
.github/workflows/    Pruebas y Desplegar
```

## Instalación (una sola vez, ~30 min)

### 1. Google
1. Activa la **API de Apps Script**: <https://script.google.com/home/usersettings> → *Google Apps Script API* → Activado.
2. Sube `hoja/Asistencia_Docentes_UFPS.xlsx` a Google Drive → *Abrir con Hojas de cálculo de Google* → *Archivo → Guardar como Hojas de cálculo de Google*. Mantén la hoja **privada**.
3. En la hoja: *Extensiones → Apps Script* (se crea el proyecto). En ⚙ *Configuración del proyecto* copia el **ID de la secuencia de comandos**.

### 2. Cloudflare (gratis)
1. Crea una cuenta en <https://dash.cloudflare.com> → *Workers & Pages*. La primera vez te pide elegir un subdominio `workers.dev`.
2. Copia el **Account ID** (columna derecha de *Workers & Pages*).
3. *Mi perfil → API Tokens → Create Token →* plantilla **Edit Cloudflare Workers** → copia el token.

### 3. GitHub
1. Abre este repositorio → botón verde **Code → Codespaces → Create codespace on main**.
2. En la terminal del Codespace ejecuta:
   ```bash
   bash scripts/configurar.sh
   ```
   El script te guía: autoriza GitHub, inicia sesión en Google (copias y pegas una URL), te pide el ID de la hoja y los datos de Cloudflare, guarda los **5 secretos** del repositorio y lanza el despliegue.
3. Cuando termine el workflow **Desplegar** (pestaña *Actions*), el resumen muestra la **URL del Worker**.

### 4. En la hoja
1. Recarga la hoja → menú **Pulso · Asistencia → 1. Autorizar y verificar instalación** (acepta los permisos).
2. En **Config** pega la *URL del Worker*, tu correo y las fechas del semestre. Llena la columna **Correo** en **Docentes**.
3. Menú → **2. Generar enlaces personales** → **3. Enviar enlaces por correo** → **4. Activar automatización**.
4. Vuelve a ejecutar **Desplegar** en GitHub (*Actions → Desplegar → Run workflow*): la prueba de humo debe salir ✅.

### 5. Activar la red WiFi (semanas 1–2)
- Empieza en `Validación de red = ALERTA` (registra y marca a quien está fuera de la red).
- Cada noche la hoja **Redes** se llena con las redes usadas por los docentes. Escribe **SI** en la red de la universidad (no en Claro/Movistar/Tigo/WOM ni VPN). O pide los rangos de IP a Sistemas y agrégalos.
- Luego cambia a `EXIGIR`.

## Secretos del repositorio

*Settings → Secrets and variables → Actions* (los guarda `configurar.sh`; también se pueden crear a mano):

| Secreto | Qué es |
|---|---|
| `SCRIPT_ID` | ID de la secuencia de comandos de la hoja |
| `CLASPRC_JSON` | Credenciales de Google para clasp (contenido de `~/.clasprc.json` tras `npx clasp login --no-localhost`) |
| `WORKER_SECRETO` | Secreto compartido Worker ↔ Apps Script (`openssl rand -hex 32`) |
| `CLOUDFLARE_API_TOKEN` | Token con plantilla *Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | Account ID de Cloudflare |

Ningún secreto queda en el código: `WORKER_SECRETO` se inyecta en Apps Script durante el despliegue (`zz_secreto.gs`, no versionado) y en el Worker como secreto de Cloudflare.

## Uso diario
- **Cambiar código**: edita en GitHub (o en el Codespace) y haz commit en `main` → se prueba y se despliega. La URL de la aplicación no cambia.
- **Cambiar el horario**: edita la hoja **Horario** directamente (no requiere desplegar). Para regenerar la plantilla: edita `herramientas/datos_horario.py` y ejecuta `npm run hoja`.
- **Docente cambió de celular**: borra su celda *Celular vinculado* en **Docentes**.
- **Enlace filtrado**: borra su *Clave del enlace* → menú 2 y 3.

## Pruebas locales
```bash
npm ci
npx playwright install chromium
npm test
```

## Límites
- Valida que el docente está **en la universidad** durante su horario, no el salón exacto (eso requeriría hardware en cada salón). Puedes acotar por bloque con lat/lng/radio en **Salones**.
- Si la UFPS tiene VPN para docentes, no apruebes su rango en **Redes**.
- Ubicación, IP y foto son datos personales (Ley 1581 de 2012): informa a los docentes y obtén su autorización.
- Si las credenciales de Google se revocan (cambio de contraseña), vuelve a ejecutar `bash scripts/configurar.sh`.
