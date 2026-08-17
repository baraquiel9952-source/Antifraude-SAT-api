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

## Dar de alta/baja API keys sin redeploy

Ya no hace falta editar `API_KEYS` en Render ni esperar un redeploy para dar de
alta a un nuevo developer — las claves creadas así viven en Redis y son
efectivas al instante.

### Crear una clave nueva
```
POST /api/admin/keys
Header: x-admin-key: <tu ADMIN_KEY>
Body: { "nombre_cliente": "Nombre del cliente", "plan": "free" }
```
Regresa `{ clave, nombre, plan, creado }` — esa `clave` es lo que el cliente usa como `x-api-key`.

### Listar todas las claves activas
```
GET /api/admin/keys
Header: x-admin-key
```

### Revocar una clave
```
DELETE /api/admin/keys/<la-clave>
Header: x-admin-key
```

Nota: `API_KEYS` (la variable de entorno) sigue funcionando como claves de
arranque/bootstrap — útil para tu propia clave de pruebas — pero para clientes
reales usa `/api/admin/keys`.

## v3.0 — Validación fiscal real + historial + webhooks + docs

### Extracción de texto real (arregla el bug de RFC/CURP)
Antes se buscaba con regex sobre los bytes crudos del PDF, lo cual fallaba
porque el texto suele venir fragmentado por ajustes de espaciado. Ahora se usa
`pdfjs-dist` para reconstruir el texto real, tal como lo vería un humano.

### Validación de RFC/CURP con librerías oficiales
`validate-rfc` y `validate-curp` (npm, MIT) validan el dígito verificador real,
y se cruza que los primeros 10 caracteres del RFC coincidan con la CURP.

### Sobre el "Sello Digital" — límite honesto
Se valida el FORMATO de la Cadena Original y el Sello Digital (estructura,
que el RFC dentro coincida), pero **no es verificación criptográfica real** —
el SAT no publica el certificado público de este trámite para validación por
terceros (a diferencia de CFDI). El anuncio en las anomalías lo deja claro.

### Historial por cliente
GET /api/historial (header x-api-key) — últimos 200 análisis de esa clave.

### Webhook de alerta
POST /api/admin/webhook (header x-admin-key) — `{api_key, webhook_url}`.
Se llama automáticamente cuando un análisis sale "fraudulento".

### Documentación OpenAPI
Ver `openapi.yaml` — impórtalo en Postman o Swagger UI para navegar la API.
