// Servidor de la prueba de evaluación SEA029_2.
// Sirve la prueba (public/index.html) y guarda las entregas de los candidatos.
// Variables de entorno: CLAVE_LECTURA (clave del panel del evaluador), REDIS_URL (opcional).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUERTO = process.env.PORT || 10000;
const CLAVE = process.env.CLAVE_LECTURA || 'CAMBIE-ESTA-CLAVE';
const CLAVE_URL = process.env.REDIS_URL || '';
const PREFIJO = 'sea029:';

const PAGINA = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

// --- almacén: Key Value de Render si está configurado, memoria en caso contrario ---
const memoria = new Map();
let cliente = null;
if (CLAVE_URL) {
  try {
    const { createClient } = require('redis');
    cliente = createClient({ url: CLAVE_URL });
    cliente.on('error', (e) => console.error('kv error', e.message));
    cliente.connect().then(() => console.log('kv conectado')).catch((e) => {
      console.error('kv sin conexión, se usa memoria:', e.message);
      cliente = null;
    });
  } catch (e) {
    console.error('redis no disponible, se usa memoria:', e.message);
    cliente = null;
  }
}

async function leer(id) {
  if (cliente && cliente.isReady) {
    const t = await cliente.get(PREFIJO + id);
    return t ? JSON.parse(t) : null;
  }
  return memoria.get(id) || null;
}

async function guardar(reg) {
  if (cliente && cliente.isReady) {
    await cliente.set(PREFIJO + reg.id, JSON.stringify(reg));
    await cliente.sAdd(PREFIJO + 'ids', reg.id);
    return;
  }
  memoria.set(reg.id, reg);
}

async function borrar(id) {
  if (cliente && cliente.isReady) {
    await cliente.del(PREFIJO + id);
    await cliente.sRem(PREFIJO + 'ids', id);
    return;
  }
  memoria.delete(id);
}

async function listar() {
  if (cliente && cliente.isReady) {
    const ids = await cliente.sMembers(PREFIJO + 'ids');
    const out = [];
    for (const id of ids) {
      const r = await leer(id);
      if (r) out.push(r);
    }
    return out;
  }
  return [...memoria.values()];
}

function json(res, o, codigo) {
  const b = Buffer.from(JSON.stringify(o));
  res.writeHead(codigo || 200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(b);
}

function resumen(r) {
  return { id: r.id, name: r.name, dni: r.dni, status: r.status, progress: r.progress, updated: r.updated };
}

async function recibir(req, res) {
  let datos = '';
  let exceso = false;
  req.on('data', (c) => {
    datos += c;
    if (datos.length > 12e6) { exceso = true; req.destroy(); }
  });
  req.on('end', async () => {
    if (exceso) return;
    let d = null;
    try { d = JSON.parse(datos); } catch (e) { return json(res, { ok: false, error: 'json' }, 400); }
    if (!d || !d.id) return json(res, { ok: false, error: 'id' }, 400);
    if (d.action === 'del') {
      if (d.key !== CLAVE) return json(res, { ok: false, error: 'clave' }, 403);
      try { await borrar(String(d.id)); return json(res, { ok: true }); }
      catch (e) { console.error('del', e.message); return json(res, { ok: false, error: 'servidor' }, 500); }
    }
    try {
      const previo = await leer(d.id);
      // Una prueba ya entregada no vuelve a "en curso".
      if (previo && previo.status === 'entregada' && d.status !== 'entregada') return json(res, { ok: true });
      const reg = {
        id: String(d.id).slice(0, 80),
        name: String(d.name || '').slice(0, 200),
        dni: String(d.dni || '').slice(0, 60),
        status: String(d.status || '').slice(0, 40),
        progress: String(d.progress || '').slice(0, 200),
        updated: Date.now(),
        payload: d.payload || (previo ? previo.payload : null),
      };
      await guardar(reg);
      json(res, { ok: true });
    } catch (e) {
      console.error('post', e.message);
      json(res, { ok: false, error: 'servidor' }, 500);
    }
  });
}

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    });
    return res.end();
  }

  if (p === '/api' && req.method === 'POST') return recibir(req, res);

  if (p === '/api' && req.method === 'GET') {
    const a = u.searchParams.get('action');
    try {
      if (a === 'ack') {
        const r = await leer(u.searchParams.get('id') || '');
        return json(res, { ok: true, status: r ? r.status : null });
      }
      if (u.searchParams.get('key') !== CLAVE) return json(res, { ok: false, error: 'clave' }, 403);
      if (a === 'list') {
        const items = (await listar()).map(resumen).sort((x, y) => y.updated - x.updated);
        return json(res, { ok: true, items });
      }
      if (a === 'get') {
        const r = await leer(u.searchParams.get('id') || '');
        return json(res, { ok: !!r, payload: r ? r.payload : null });
      }
      return json(res, { ok: false, error: 'accion' }, 400);
    } catch (e) {
      console.error('get', e.message);
      return json(res, { ok: false, error: 'servidor' }, 500);
    }
  }

  if (p === '/salud') return json(res, { ok: true, kv: !!(cliente && cliente.isReady) });

  if (req.method === 'GET' || req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : PAGINA);
  }

  res.writeHead(405).end();
});

servidor.listen(PUERTO, () => console.log('escuchando en ' + PUERTO));
