# Antifraude SAT API — v2.0.0-forense (motor combinado: estructura + QR)

API REST que analiza un PDF (constancia fiscal, acta, etc.) y regresa un score de
confiabilidad 0-100 con las anomalías detectadas, combinando:

- **Análisis estructural** (port de ActaForensic Pro + 15 mejoras): streams
  comprimidos, /ID de trailer, /ByteRange de firma, cadena /Prev, JavaScript
  embebido, formularios sin aplanar, cifrado, sanity check de /Size, whitelist
  de software legítimo, combo-penalty/tope de score, tipo de documento configurable.
- **Análisis de QR/dominio** (port de Antifraude_SAT_4_0.apk): renderiza cada
  página con pdfjs-dist + canvas, escanea códigos QR con jsQR, valida el dominio
  contra `.gob.mx`, detecta acortadores y dominios imitadores del SAT, cruza el
  RFC del texto contra el RFC codificado en el QR.
- **Deduplicación por hash** — informa si el mismo archivo exacto ya se había
  analizado antes (no penaliza, solo informa).
- **Planes free/paid con límites persistentes** en Redis (Render Key Value).

## Variables de entorno

| Variable | Requerida | Uso |
|---|---|---|
| `API_KEYS` | No | Lista separada por comas de claves válidas. Sin esto, la API queda en modo abierto (desarrollo, sin límites de plan). |
| `REDIS_URL` | No (pero recomendada) | Conexión al Key Value de Render `antifraude-sat-store`. Sin esto, los límites de plan y la dedupe de hash quedan desactivados ("modo sin persistencia") pero la API sigue funcionando. |
| `ADMIN_KEY` | No | Clave para el panel de administración de planes (`/api/admin/*`). Sin esto, esos endpoints quedan bloqueados (503). |

### Cómo conseguir REDIS_URL
1. En el dashboard de Render → Key Value → `antifraude-sat-store` → pestaña "Connect".
2. Copia la "Internal Connection String" (si la API vive en el mismo workspace/región) o la externa si no.
3. Ponla como `REDIS_URL` en las variables de entorno del servicio `antifraude-sat-api`.

## Endpoints

### POST /api/verificar
Header: `x-api-key` (si configuraste API_KEYS)
Body: form-data — `documento` (PDF), `tipo_documento` (opcional: constancia_fiscal | acta | generico)

### POST /api/verificar-lote
Body: form-data — `documentos` (varios PDFs), `tipo_documento` (opcional)

### GET /api/uso
Header: `x-api-key` obligatorio. Plan, uso del mes y límite.

### POST /api/reporte
Body JSON: `{ "resultado": <respuesta de /api/verificar>, "nombre_documento": "..." }` → PDF descargable.

### POST /api/admin/plan
Header: `x-admin-key`. Body: `{ "api_key": "...", "plan": "free"|"pro" }`

### GET /api/admin/planes-disponibles
Header: `x-admin-key`. Lista los planes y sus límites.

### GET /health

## Nota sobre `canvas` en Render
El paquete `canvas` (node-canvas) usa un binario nativo precompilado para la
mayoría de plataformas Linux x64, que es como corre Render. Si el build fallara
por falta de librerías del sistema, la alternativa es cambiar a `@napi-rs/canvas`
en `lib/qrAnalyzer.js` (haría falta un canvasFactory manual para pdfjs-dist).

## Correr local
npm install
npm start

## Desplegar en Render
Build command: `npm install`
Start command: `node server.js`
