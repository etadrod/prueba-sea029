// Servidor de la prueba de evaluación SEA029_2.
// Sirve la prueba (public/index.html) y guarda las entregas de los candidatos.
// Variables de entorno: CLAVE_LECTURA (contraseñas de evaluador separadas por comas), REDIS_URL (opcional),
// ANTHROPIC_API_KEY (opcional: valoración automática de los supuestos prácticos).

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUERTO = process.env.PORT || 10000;
const CLAVES = (process.env.CLAVE_LECTURA || '').split(',').map((x) => x.trim()).filter(Boolean);
const claveOk = (k) => typeof k === 'string' && CLAVES.includes(k.trim());
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

// --- valoración de supuestos prácticos con Claude ---
let anthropic = null;
if (process.env.ANTHROPIC_API_KEY) {
  try {
    const Anthropic = require('@anthropic-ai/sdk');
    anthropic = new Anthropic();
  } catch (e) {
    console.error('sdk de Anthropic no disponible:', e.message);
  }
}

const SISTEMA = `Eres evaluador/a del procedimiento de acreditación de competencias profesionales (cualificación SEA029_2 Vigilancia y seguridad privada).
Valoras la respuesta escrita de un candidato/a a uno o varios supuestos prácticos de una unidad de competencia, contrastándola con las "Respuestas a considerar como correctas por el evaluador".
Escribe en español un único párrafo de unas 100 palabras (entre 80 y 120), en tercera persona ("El candidato/a..."), que explique qué actuaciones de referencia recoge correctamente y cuáles omite o plantea de forma incorrecta o contraria a la normativa.
No incluyas propuestas de mejora, recomendaciones, notas numéricas, títulos, listas ni formato markdown. No inventes contenido que no esté en la respuesta. Si la respuesta está vacía o no guarda relación con el supuesto, dilo expresamente.`;

function textoUC(it) {
  let t = `Unidad de competencia: ${it.uc} ${it.title || ''}\n`;
  for (const sp of it.sps) {
    t += `\n--- Supuesto práctico ${sp.n} ---\nEnunciado:\n${sp.text.join('\n')}\n\nRespuestas a considerar como correctas por el evaluador:\n${sp.ref.map((r) => '- ' + r).join('\n')}\n\nRespuesta del candidato/a:\n${String(sp.answer || '').trim() || '(sin respuesta)'}\n`;
  }
  return t;
}

async function valorarUC(it) {
  const r = await anthropic.beta.messages.create({
    model: 'claude-opus-5-5',
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: { effort: 'medium' },
    system: SISTEMA,
    messages: [{ role: 'user', content: textoUC(it) }],
  });
  if (r.stop_reason === 'refusal') throw new Error('rechazo');
  return r.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

async function valorar(d, res) {
  if (!claveOk(d.key)) return json(res, { ok: false, error: 'clave' }, 403);
  if (!anthropic) return json(res, { ok: false, error: 'sin_clave_api' });
  const items = (Array.isArray(d.items) ? d.items : []).filter((it) => it && it.uc && Array.isArray(it.sps) && it.sps.length).slice(0, 3);
  const previo = await leer(String(d.id));
  const cache = (previo && previo.val) || {};
  const val = {};
  await Promise.all(items.map(async (it) => {
    if (cache[it.uc]) { val[it.uc] = cache[it.uc]; return; }
    try { val[it.uc] = await valorarUC(it); }
    catch (e) { console.error('valorar', it.uc, e.message); }
  }));
  if (previo && Object.keys(val).length) {
    previo.val = { ...cache, ...val };
    await guardar(previo);
  }
  json(res, { ok: true, val });
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
    if (d.action === 'valorar') {
      try { return await valorar(d, res); }
      catch (e) { console.error('valorar', e.message); return json(res, { ok: false, error: 'servidor' }, 500); }
    }
    if (d.action === 'del') {
      if (!claveOk(d.key)) return json(res, { ok: false, error: 'clave' }, 403);
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
        val: previo ? previo.val : undefined,
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
      if (!claveOk(u.searchParams.get('key'))) return json(res, { ok: false, error: 'clave' }, 403);
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

  if (p === '/salud') return json(res, { ok: true, kv: !!(cliente && cliente.isReady), valoracion: !!anthropic });

  if (req.method === 'GET' || req.method === 'HEAD') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    return res.end(req.method === 'HEAD' ? undefined : PAGINA);
  }

  res.writeHead(405).end();
});

servidor.listen(PUERTO, () => console.log('escuchando en ' + PUERTO));
