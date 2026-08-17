# Antifraude SAT API

API REST que analiza forense un PDF (constancia fiscal, acta, etc.) y regresa un score de confiabilidad 0-100 con las anomalías detectadas.

## Endpoint

POST /api/verificar
Header: x-api-key: <tu-clave>  (si configuraste API_KEYS)
Body: form-data, campo "documento" = archivo PDF

Respuesta:
{
  "score": 40,
  "veredicto": "sospechoso",
  "anomalias": [...],
  "detalles_tecnicos": {...}
}

## Correr local

npm install
npm start

## Desplegar en Render

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render: New > Web Service > conecta el repo.
3. Build command: npm install
4. Start command: npm start
5. Variable de entorno opcional API_KEYS=clave1,clave2 (clientes que pagan usan su clave en el header x-api-key)

## Subir este repo a GitHub desde cero

git init
git add .
git commit -m "Antifraude SAT API"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/antifraude-sat-api.git
git push -u origin main
