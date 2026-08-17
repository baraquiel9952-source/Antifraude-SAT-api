// Conexión al Key Value (Redis) de Render. Si REDIS_URL no está configurada
// todavía, el resto del sistema sigue funcionando en "modo abierto" — sin
// límites de plan ni deduplicación de hash — en vez de tumbar el servicio.

const Redis = require('ioredis');

let cliente = null;
let disponible = false;

function obtenerCliente() {
  if (cliente) return cliente;
  const url = process.env.REDIS_URL;
  if (!url) return null;

  cliente = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
  cliente.on('error', () => { disponible = false; });
  cliente.on('ready', () => { disponible = true; });
  cliente.connect().catch(() => { disponible = false; });
  return cliente;
}

function estaDisponible() {
  return disponible;
}

module.exports = { obtenerCliente, estaDisponible };
