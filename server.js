'use strict';
/*
 * Painel de Rotas: servidor sem dependências externas (somente Node.js 18+).
 * Guarda os dados em um arquivo JSON, busca endereços (Nominatim/OpenStreetMap),
 * calcula rotas pelas ruas (OSRM), roteiriza as entregas e envia atualizações em tempo real (SSE).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Clean = require('./public/clean.js');
const { createStore } = require('./storage.js');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const NOMINATIM_URL = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
const OSRM_URL = (process.env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, '');
const CEP_URL = (process.env.CEP_URL || 'https://brasilapi.com.br/api/cep/v2').replace(/\/$/, '');
const VIACEP_URL = (process.env.VIACEP_URL || 'https://viacep.com.br/ws').replace(/\/$/, '');
const GOOGLE_KEY = process.env.GOOGLE_MAPS_KEY || '';
const GOOGLE_URL = process.env.GOOGLE_GEOCODE_URL || 'https://maps.googleapis.com/maps/api/geocode/json';
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || '';
const COUNTRY_CODES = process.env.COUNTRY_CODES === undefined ? 'br' : process.env.COUNTRY_CODES;
const GEO_GAP_MS = process.env.GEO_GAP_MS === undefined ? 1100 : Number(process.env.GEO_GAP_MS);
const envNum = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : Number(process.env[k]));
const GEO_RETRIES = envNum('GEO_RETRIES', 2);              // novas tentativas imediatas por consulta
const GEO_RETRY_MS = envNum('GEO_RETRY_MS', 5000);         // espera base entre elas (x3 em caso de 429)
const GEO_REQUEUE_TRIES = envNum('GEO_REQUEUE_TRIES', 3);  // rodadas por cliente antes de marcar "indisponível"
const GEO_REQUEUE_MS = envNum('GEO_REQUEUE_MS', 120000);   // espera antes de cada nova rodada (2, 4 min...)
const SERVICE_MIN = 4;
const SPEED_KMH = 30;
const DETOUR = 1.3;
const PRIO_PEN = 1.5;
const PRIO_BONUS = 5;
const UA = 'PainelDeRotas/1.0' + (CONTACT_EMAIL ? ' (' + CONTACT_EMAIL + ')' : '');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ---------------- armazenamento ---------------- */
const store = createStore(DATA_DIR);
const emptyDb = () => ({ vehicles: [], deliveries: [], clients: [], cepcache: {}, depot: null, settings: { suffix: '' }, routes: {}, summary: null, geocache: {} });
let db = emptyDb();
/* Grava no máximo uma vez a cada store.delayMs; alterações feitas durante a gravação geram outra em seguida. */
let saveTimer = null, saving = null, dirty = false, saveProblem = '';
function setSaveProblem(msg) {
  if (msg === saveProblem) return;
  saveProblem = msg;
  broadcast('state', publicState());
}
/* Outra cópia do app gravou no banco depois de nós: em vez de sobrescrever, adota o que está no banco. */
async function reloadFromStore() {
  console.error('Outra cópia do app gravou no banco. Recarregando os dados do banco em vez de sobrescrever.');
  const fresh = await store.reload();
  db = { ...emptyDb(), ...(fresh || {}) };
  clientQ.length = 0;
  resumePending();
  broadcast('state', publicState()); broadcast('routes', { at: Date.now() });
}
async function flush() {
  if (saving) { dirty = true; return saving; }
  dirty = false;
  saving = store.save(JSON.stringify(db))
    .then(() => setSaveProblem(''))
    .catch(async e => {
      if (e.code === 'CONFLITO') {
        try { await reloadFromStore(); setSaveProblem(''); } catch (e2) { console.error('Falha ao recarregar:', e2.message); setSaveProblem('Não foi possível ler o banco de dados. As alterações podem não estar sendo salvas.'); dirty = true; }
        return;
      }
      console.error('Falha ao salvar:', e.message); dirty = true;
      setSaveProblem('Não foi possível salvar no banco de dados. Tentando de novo…');
    })
    .finally(() => { saving = null; if (dirty) persist(); });
  return saving;
}
function persist() {
  dirty = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; flush(); }, store.delayMs);
}
let stopping = false;
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => {
  if (stopping) return; stopping = true;
  clearTimeout(saveTimer);
  try { if (saving) await saving; if (store.saveSync) store.saveSync(JSON.stringify(db)); else await store.save(JSON.stringify(db)); }
  catch (e) { console.error(e.code === 'CONFLITO' ? 'Ao encerrar: outra cópia do app já gravou no banco; nada foi sobrescrito.' : 'Falha ao salvar: ' + e.message); }
  process.exit(0);
});

/* ---------------- tempo real (SSE) ---------------- */
const clients = new Set();
let bcastTimer = null;
function publicState() {
  return {
    vehicles: db.vehicles, deliveries: db.deliveries, depot: db.depot, settings: db.settings, summary: db.summary,
    geoPending: db.deliveries.filter(d => d.geoStatus === 'pendente' && !d.clientId).length + db.clients.filter(c => c.geoStatus === 'pendente').length,
    clientCount: db.clients.length, clientFailed: db.clients.filter(c => c.geoStatus === 'falhou').length,
    storageWarning: store.temporary ? 'Os dados estão num arquivo temporário e serão APAGADOS quando o servidor reiniciar. Configure a variável DATABASE_URL (veja o README).' : saveProblem
  };
}
function broadcast(type, data) {
  const msg = 'event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) res.write(msg);
}
function changed() {
  persist();
  if (bcastTimer) return;
  bcastTimer = setTimeout(() => { bcastTimer = null; broadcast('state', publicState()); }, 120);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

/* ---------------- utilidades ---------------- */
class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null));
const validLat = v => v !== null && v >= -90 && v <= 90;
const validLng = v => v !== null && v >= -180 && v <= 180;
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
const uid = () => crypto.randomBytes(6).toString('hex');
const cleanSuffix = x => x.replace(/\s+[-–]\s+/g, ', ');
const withSuffix = q => (db.settings.suffix ? q + ', ' + cleanSuffix(db.settings.suffix) : q);

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req, limit = 8e6) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'Arquivo grande demais.')); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(new HttpError(400, 'Dados inválidos.')); }
    });
    req.on('error', reject);
  });
}
function isAdmin(req) {
  if (!ADMIN_PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pw = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(pw), b = Buffer.from(ADMIN_PASSWORD);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------------- busca de endereços ---------------- */
const geoQueue = []; let geoBusy = false, lastGeo = 0;
function geoRequest(q, limit) {
  return new Promise((resolve, reject) => { geoQueue.push({ q, limit, resolve, reject }); pumpGeo(); });
}
async function pumpGeo() {
  if (geoBusy) return;
  geoBusy = true;
  while (geoQueue.length) {
    const job = geoQueue.shift();
    const wait = lastGeo + GEO_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastGeo = Date.now();
    try { job.resolve(await nominatimRetry(job.q, job.limit)); } catch (e) { job.reject(e); }
  }
  geoBusy = false;
}
/* Falha passageira (429 "devagar", 5xx, sem resposta): espera e tenta de novo, segurando a fila inteira
   para não insistir no serviço. 403 é bloqueio e não adianta repetir. */
async function nominatimRetry(q, limit) {
  for (let i = 0; ; i++) {
    try { return await nominatim(q, limit); }
    catch (e) {
      const st = e.status || 0, passageira = !st || st === 429 || st >= 500;
      if (st === 403) console.error('Busca de endereços recusada pelo OpenStreetMap (403, bloqueio). Confira se CONTACT_EMAIL está definida.');
      if (!passageira || i >= GEO_RETRIES) throw e;
      const ms = GEO_RETRY_MS * (i + 1) * (st === 429 ? 3 : 1);
      console.warn('Busca de endereços: ' + e.message + '. Nova tentativa em ' + Math.round(ms / 1000) + 's.');
      await sleep(ms); lastGeo = Date.now();
    }
  }
}
async function nominatim(q, limit) {
  const u = new URL(NOMINATIM_URL + '/search');
  if (typeof q === 'object') for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v); else u.searchParams.set('q', q);
  u.searchParams.set('format', 'jsonv2'); u.searchParams.set('addressdetails', '1'); u.searchParams.set('limit', String(limit));
  if (COUNTRY_CODES) u.searchParams.set('countrycodes', COUNTRY_CODES);
  const r = await fetch(u, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) { const e = new Error('serviço respondeu ' + r.status); e.status = r.status; throw e; }
  const j = await r.json();
  return j.map(x => { const a = x.address || {}; return { label: x.display_name, lat: Number(x.lat), lng: Number(x.lon), postcode: a.postcode || '', state: a.state || '', city: a.city || a.town || a.village || a.municipality || '' }; }).filter(x => validLat(x.lat) && validLng(x.lng));
}
function cacheSet(key, val) {
  const keys = Object.keys(db.geocache);
  if (keys.length > 5000) for (const k of keys.slice(0, 1000)) delete db.geocache[k];
  db.geocache[key] = val;
}
const UF = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };
const NUM_ONLY = /^(?:n[º°o]?\.?\s*)?(\d{1,6}[A-Za-z]?)$/i;
function parseAddress(addr) {
  const parts = addr.split(',').map(s => s.trim()).filter(Boolean);
  let street = parts[0] || '', number = '', rest = parts.slice(1);
  const m = street.match(/^(.*\D)\s+(?:n[º°o]?\.?\s*)?(\d{1,6}[A-Za-z]?)$/i);
  if (m) { street = m[1].trim(); number = m[2]; }
  else if (rest.length && NUM_ONLY.test(rest[0])) { number = rest[0].match(NUM_ONLY)[1]; rest = rest.slice(1); }
  return { street, number, rest };
}
function cityState(pieces) {
  const parts = pieces.slice(); let state = '';
  if (parts.length && /^[A-Za-z]{2}$/.test(parts[parts.length - 1])) state = UF[parts.pop().toUpperCase()] || '';
  return { city: parts.pop() || '', state };
}
async function searchChain(addr, limit) {
  const p = parseAddress(addr);
  const suffix = cleanSuffix(db.settings.suffix || '').split(',').map(s => s.trim()).filter(Boolean);
  const loc = cityState([...p.rest, ...suffix]);
  const struct = (street, approx) => ({ q: { street, city: loc.city, ...(loc.state ? { state: loc.state } : {}) }, approx });
  const tries = [{ q: withSuffix(addr), approx: false }];
  if (p.number && loc.city) tries.push(struct(p.number + ' ' + p.street, false));
  if (p.number) tries.push({ q: withSuffix([p.street, ...p.rest].join(', ')), approx: true });
  if (loc.city && p.street) tries.push(struct(p.street, !!p.number));
  const seen = new Set();
  for (const t of tries) {
    const key = JSON.stringify(t.q); if (seen.has(key)) continue; seen.add(key);
    const res = await geoRequest(t.q, limit);
    if (res.length) return { results: res.map(r => ({ ...r, approx: t.approx })), approx: t.approx };
  }
  return { results: [], approx: false };
}
async function geocodeAddress(addr, force) {
  const key = 'g2:' + withSuffix(addr).toLowerCase();
  if (!force && db.geocache[key] !== undefined) return db.geocache[key];
  const { results, approx } = await searchChain(addr, 1);
  const out = results.length ? { lat: results[0].lat, lng: results[0].lng, label: results[0].label, approx } : null;
  cacheSet(key, out);
  return out;
}
async function runGeo(id, force) {
  const d = db.deliveries.find(x => x.id === id);
  if (!d || d.geoStatus !== 'pendente') return;
  try {
    const r = await geocodeAddress(d.address, force);
    if (r) { Object.assign(d, { lat: r.lat, lng: r.lng, label: r.label, approx: r.approx, geoStatus: 'ok', geoError: '' }); }
    else { Object.assign(d, { geoStatus: 'falhou', geoError: 'Endereço não encontrado' }); }
  } catch (e) {
    console.error('Busca de endereço da entrega falhou: ' + e.message);
    Object.assign(d, { geoStatus: 'falhou', geoError: 'Serviço de busca indisponível. Tente de novo.' });
  }
  changed();
}

function applyClientGeo(c) {
  for (const d of db.deliveries) {
    if (d.clientId !== c.id || d.status !== 'pendente' || d.geoStatus === 'ok') continue;
    if (c.geoStatus === 'ok') Object.assign(d, { lat: c.lat, lng: c.lng, label: c.label, approx: c.approx, geoStatus: 'ok', geoError: '' });
    else if (c.geoStatus === 'falhou') Object.assign(d, { geoStatus: 'falhou', geoError: c.geoError });
  }
}
/* ----- localização de clientes: CEP, Google (opcional) e OpenStreetMap ----- */
const cepHeaders = { 'User-Agent': UA };
async function lookupCep(cep) {
  if (db.cepcache[cep] !== undefined) return db.cepcache[cep];
  let out;
  try {
    const r = await fetch(CEP_URL + '/' + cep, { headers: cepHeaders, signal: AbortSignal.timeout(12000) });
    if (r.ok) {
      const j = await r.json(), co = (j.location && j.location.coordinates) || {};
      const lat = Number(co.latitude), lng = Number(co.longitude);
      out = { city: j.city || '', uf: j.state || '', street: j.street || '', bairro: j.neighborhood || '', lat: validLat(lat) && validLng(lng) && lat !== 0 ? lat : null, lng: validLat(lat) && validLng(lng) && lat !== 0 ? lng : null };
    }
  } catch (e) { /* tenta o segundo serviço */ }
  if (!out) {
    try {
      const r = await fetch(VIACEP_URL + '/' + cep + '/json/', { headers: cepHeaders, signal: AbortSignal.timeout(12000) });
      if (r.ok) { const j = await r.json(); out = j.erro ? null : { city: j.localidade || '', uf: j.uf || '', street: j.logradouro || '', bairro: j.bairro || '', lat: null, lng: null }; }
      else if (r.status === 400 || r.status === 404) out = null;
      else return undefined;
    } catch (e) { return undefined; }
  }
  const keys = Object.keys(db.cepcache);
  if (keys.length > 6000) for (const k of keys.slice(0, 1000)) delete db.cepcache[k];
  db.cepcache[cep] = out || null;
  return out || null;
}
function pickBest(res, ctx) {
  let best = null, bs = -1;
  for (const r of res) {
    if (ctx.stateName && r.state && norm(r.state) !== norm(ctx.stateName)) continue;
    const pc = String(r.postcode || '').replace(/\D/g, '');
    /* Busca pela rua: se o CEP da planilha aponta para outra região (3 primeiros dígitos), é uma rua de mesmo nome em outro lugar. */
    if (ctx.strict && ctx.prefix && pc.length >= 3 && pc.slice(0, 3) !== ctx.prefix.slice(0, 3)) continue;
    let s = 1;
    if (ctx.prefix && pc.startsWith(ctx.prefix)) s += 4;
    if (ctx.city && r.city && norm(r.city) === norm(ctx.city)) s += 2;
    if (ctx.bairro && norm(r.label).includes(norm(ctx.bairro))) s += 3;
    if (s > bs) { bs = s; best = r; }
  }
  return best;
}
async function googleGeocode(address, components) {
  const u = new URL(GOOGLE_URL);
  u.searchParams.set('address', address); u.searchParams.set('components', components);
  u.searchParams.set('region', 'br'); u.searchParams.set('language', 'pt-BR'); u.searchParams.set('key', GOOGLE_KEY);
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('google http ' + r.status);
  const j = await r.json();
  if (j.status === 'ZERO_RESULTS') return null;
  if (j.status !== 'OK' || !j.results || !j.results[0]) throw new Error('google ' + j.status);
  const x = j.results[0], loc = x.geometry.location, comp = t => (x.address_components || []).find(a => a.types.includes(t));
  const city = (comp('locality') || comp('administrative_area_level_2') || {}).long_name || '';
  return { lat: loc.lat, lng: loc.lng, label: x.formatted_address, city, uf: (comp('administrative_area_level_1') || {}).short_name || '',
    approx: !!x.partial_match || !['ROOFTOP', 'RANGE_INTERPOLATED'].includes(x.geometry.location_type) };
}
async function geocodeClient(c) {
  const cep = c.cep || '';
  const info = cep.length === 8 ? await lookupCep(cep) : null;
  const uf = c.uf || (info && info.uf) || Clean.ufFromCep(cep) || '';
  let city = c.city || (info && info.city) || '', stateName = Clean.UF_NAMES[uf] || '';
  if (!city && !uf) { const s = cityState(cleanSuffix(db.settings.suffix || '').split(',').map(x => x.trim()).filter(Boolean)); city = s.city; stateName = s.state; }
  const street = c.street || (info && info.street) || '', bairro = c.bairro || (info && info.bairro) || '', number = c.street ? c.number : '';
  const out = (g, approx, source) => ({ lat: g.lat, lng: g.lng, label: g.label || '', approx: approx || !number, city: g.city || city, uf: g.uf || uf, source });
  if (GOOGLE_KEY) {
    const comp = 'country:BR' + (cep.length === 8 ? '|postal_code:' + Clean.fmtCep(cep) : '');
    const tries = [];
    if (street || cep.length === 8) tries.push({ a: [street && (number ? street + ', ' + number : street), bairro, city, uf].filter(Boolean).join(', ') + ', Brasil', approx: false });
    if (street && number) tries.push({ a: [street, bairro, city, uf].filter(Boolean).join(', ') + ', Brasil', approx: true });
    for (const t of tries) { const g = await googleGeocode(t.a, comp); if (g) return out(g, t.approx || g.approx, 'google'); }
    return null;
  }
  if (street) {
    const ctx = { stateName, city, bairro, strict: true, prefix: cep.length >= 5 ? cep.slice(0, 5) : '' };
    const tries = [];
    if (number && city) tries.push({ q: { street: number + ' ' + street, city, ...(stateName ? { state: stateName } : {}) }, approx: false });
    tries.push({ q: [street + (number ? ', ' + number : ''), bairro, city, stateName].filter(Boolean).join(', '), approx: false });
    if (number) tries.push({ q: [street, bairro, city, stateName].filter(Boolean).join(', '), approx: true });
    for (const t of tries) {
      const best = pickBest(await geoRequest(t.q, 5), ctx);
      if (best) return out(best, t.approx, 'osm');
    }
  }
  if (info && info.lat != null) return out({ lat: info.lat, lng: info.lng, label: 'Posição do CEP ' + Clean.fmtCep(cep), city: info.city, uf: info.uf }, true, 'cep');
  /* Rua nova ou sem cadastro no OpenStreetMap: usa uma posição aproximada (CEP, bairro ou cidade) em vez de falhar */
  const ctx2 = { stateName, city, prefix: cep.length >= 5 ? cep.slice(0, 5) : '' };
  const rough = [];
  if (cep.length === 8) rough.push({ q: { postalcode: Clean.fmtCep(cep), country: 'Brasil' }, why: 'CEP ' + Clean.fmtCep(cep) });
  if (bairro && city) rough.push({ q: [bairro, city, stateName].filter(Boolean).join(', '), why: 'bairro ' + bairro });
  if (city) rough.push({ q: [city, stateName].filter(Boolean).join(', '), why: 'centro de ' + city });
  for (const t of rough) {
    const best = pickBest(await geoRequest(t.q, 5), ctx2);
    if (best) { const o = out({ lat: best.lat, lng: best.lng, label: 'Posição aproximada (' + t.why + ')', city: best.city, uf }, true, 'aprox'); o.approx = true; return o; }
  }
  c.address = Clean.fmtAddress({ ...c, city: c.city || city, uf: c.uf || uf, bairro: c.bairro || bairro });
  return null;
}
async function runGeoClient(id) {
  const c = db.clients.find(x => x.id === id);
  if (!c || c.geoStatus !== 'pendente') return;
  try {
    const r = await geocodeClient(c);
    if (r) { Object.assign(c, { lat: r.lat, lng: r.lng, label: r.label, approx: r.approx, geoStatus: 'ok', geoError: '', geoSource: r.source, city: r.city || c.city, uf: r.uf || c.uf }); c.address = Clean.fmtAddress(c); }
    else Object.assign(c, { geoStatus: 'falhou', geoError: 'Endereço não encontrado no mapa' });
    c.geoTries = 0;
  } catch (e) {
    const keyDenied = GOOGLE_KEY && /REQUEST_DENIED|google http 4/.test(e.message);
    console.error('Busca do cliente ' + (c.code || c.name) + ' falhou: ' + e.message);
    c.geoTries = (c.geoTries || 0) + 1;
    if (!keyDenied && c.geoTries < GEO_REQUEUE_TRIES) {
      /* Problema no serviço, não no endereço: continua pendente e tenta de novo mais tarde, sozinho. */
      const ms = GEO_REQUEUE_MS * c.geoTries;
      c.geoError = '';
      setTimeout(() => enqueueClientGeo(c.id), ms).unref();
      changed(); return;
    }
    c.geoTries = 0;
    Object.assign(c, { geoStatus: 'falhou', geoError: keyDenied ? 'Chave do Google recusada. Confira a chave e se a Geocoding API está ativada.' : 'Serviço de busca indisponível. Tente de novo.' });
  }
  applyClientGeo(c); changed();
}
function resumePending() {
  /* Clientes que falharam por problema no serviço (não no endereço) voltam para a fila. */
  for (const c of db.clients) if (c.geoStatus === 'falhou' && /^Serviço de busca indisponível/.test(c.geoError || '')) Object.assign(c, { geoStatus: 'pendente', geoError: '', geoTries: 0 });
  db.clients.filter(c => c.geoStatus === 'pendente').forEach(c => enqueueClientGeo(c.id));
  db.deliveries.filter(d => d.geoStatus === 'pendente' && !d.clientId).forEach(d => runGeo(d.id));
}
const clientQ = []; let clientBusy = false;
function enqueueClientGeo(id) { if (!clientQ.includes(id)) clientQ.push(id); pumpClients(); }
async function pumpClients() {
  if (clientBusy) return;
  clientBusy = true;
  try { while (clientQ.length) await runGeoClient(clientQ.shift()); } finally { clientBusy = false; }
}
function clientFields(row) {
  const rawStreet = str(row.street !== undefined ? row.street : row.address, 200), sp = Clean.cleanStreet(rawStreet), uf = str(row.uf, 2).toUpperCase();
  return {
    code: str(row.code, 40), name: Clean.cleanName(str(row.client, 160)) || 'Sem nome', street: sp.street, number: sp.number,
    bairro: Clean.titleCase(str(row.bairro, 80) || sp.tail).slice(0, 80), cep: Clean.cleanCep(row.cep), city: Clean.titleCase(str(row.city, 80)),
    uf: Clean.UF_NAMES[uf] ? uf : '', notes: str(row.notes, 300), raw: rawStreet
  };
}
const clientSig = f => [f.street, f.number, f.bairro, f.cep, f.city, f.uf].join('|');
const clientUsable = f => !!f.street || f.cep.length === 8;
function addClientDelivery(c, now) {
  if (db.deliveries.some(d => d.clientId === c.id && d.status === 'pendente')) return null;
  const d = newDelivery({ client: c.name, address: c.address, notes: c.notes }, now + db.deliveries.length);
  Object.assign(d, { clientId: c.id, code: c.code || '' });
  if (c.geoStatus === 'ok') Object.assign(d, { lat: c.lat, lng: c.lng, label: c.label, approx: c.approx, geoStatus: 'ok', geoError: '' });
  else if (c.geoStatus === 'falhou') Object.assign(d, { geoStatus: 'falhou', geoError: c.geoError });
  else d.geoStatus = 'pendente';
  db.deliveries.push(d);
  return d;
}

/* ---------------- rotas pelas ruas ---------------- */
async function osrmRoute(points) {
  const coords = points.map(p => p.lng + ',' + p.lat).join(';');
  const r = await fetch(OSRM_URL + '/route/v1/driving/' + coords + '?overview=full&geometries=geojson&steps=false',
    { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error('osrm ' + r.status);
  const j = await r.json();
  if (j.code !== 'Ok' || !j.routes || !j.routes[0]) throw new Error('rota indisponível');
  const rt = j.routes[0];
  return {
    distanceM: rt.distance, durationS: rt.duration,
    geometry: rt.geometry.coordinates.map(([lng, lat]) => [Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]),
    legs: rt.legs.map(l => ({ distanceM: l.distance, durationS: l.duration }))
  };
}

/* ---------------- roteirização ---------------- */
function hav(a, b) {
  const rad = Math.PI / 180, dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(s));
}
const dist = (a, b) => hav(a, b) * DETOUR;
function pathKm(start, order, depot) { let km = 0, c = start; for (const s of order) { km += dist(c, s); c = s; } return km + dist(c, depot); }
function pathCost(start, order, depot) {
  let cost = pathKm(start, order, depot);
  order.forEach((s, i) => { if (s.priority === 'alta') cost += PRIO_PEN * i; });
  return cost;
}
function buildOrder(start, stops, depot) {
  const left = stops.slice(), order = []; let cur = start;
  while (left.length) {
    let bi = 0, bv = Infinity;
    left.forEach((s, i) => { const v = dist(cur, s) - (s.priority === 'alta' ? PRIO_BONUS : 0); if (v < bv) { bv = v; bi = i; } });
    const s = left.splice(bi, 1)[0]; order.push(s); cur = s;
  }
  if (order.length <= 150) {
    let improved = true, guard = 0;
    while (improved && guard++ < 50) {
      improved = false;
      for (let i = 0; i < order.length - 1; i++) for (let j = i + 1; j < order.length; j++) {
        const cand = order.slice(0, i).concat(order.slice(i, j + 1).reverse(), order.slice(j + 1));
        if (pathCost(start, cand, depot) < pathCost(start, order, depot) - 1e-9) { order.splice(0, order.length, ...cand); improved = true; }
      }
    }
  }
  return order;
}
function plan(depot, vehs, stops) {
  const k = vehs.length, n = stops.length;
  const starts = vehs.map(v => (v.status === 'em_rota' && validLat(num(v.lat)) && validLng(num(v.lng)) ? { lat: v.lat, lng: v.lng } : depot));
  const cosLat = Math.cos(depot.lat * Math.PI / 180);
  const ang = s => Math.atan2(s.lat - depot.lat, (s.lng - depot.lng) * cosLat);
  const sorted = stops.slice().sort((a, b) => ang(a) - ang(b));
  const maxRot = Math.min(n, 60);
  let best = null;
  for (let r = 0; r < maxRot; r++) {
    const rot = sorted.slice(r).concat(sorted.slice(0, r)), groups = []; let idx = 0;
    for (let g = 0; g < k; g++) { const size = Math.floor(n / k) + (g < n % k ? 1 : 0); groups.push(rot.slice(idx, idx + size)); idx += size; }
    const free = vehs.map((_, i) => i), assign = new Array(k);
    const gs = groups.map(g => ({ g, c: g.length ? { lat: g.reduce((s, d) => s + d.lat, 0) / g.length, lng: g.reduce((s, d) => s + d.lng, 0) / g.length } : depot }));
    for (const o of gs.sort((a, b) => b.g.length - a.g.length)) {
      let bi = -1, bv = Infinity;
      for (const i of free) { const dv = hav(starts[i], o.c); if (dv < bv) { bv = dv; bi = i; } }
      free.splice(free.indexOf(bi), 1); assign[bi] = o.g;
    }
    let cost = 0, km = 0;
    const orders = assign.map((g, i) => { const o = buildOrder(starts[i], g, depot); if (o.length) { cost += pathCost(starts[i], o, depot); km += pathKm(starts[i], o, depot); } return o; });
    if (!best || cost < best.cost) best = { cost, km, orders, starts };
  }
  return best || { cost: 0, km: 0, orders: vehs.map(() => []), starts };
}
function baselineKm(depot, vehs, stops) {
  const groups = vehs.map(() => []);
  stops.slice().sort((a, b) => a.createdAt - b.createdAt).forEach((s, i) => groups[i % vehs.length].push(s));
  return groups.reduce((t, g) => t + (g.length ? pathKm(depot, g, depot) : 0), 0);
}
let optimizing = false;
async function optimize() {
  if (!db.depot) throw new HttpError(400, 'Defina o endereço do depósito na aba Frota.');
  const vs = db.vehicles.filter(v => v.active);
  const ps = db.deliveries.filter(d => d.status === 'pendente' && d.geoStatus === 'ok');
  if (!vs.length) throw new HttpError(400, 'Cadastre e ative ao menos um veículo.');
  if (!ps.length) throw new HttpError(400, 'Não há entregas pendentes com endereço localizado.');
  if (optimizing) throw new HttpError(409, 'Já existe uma otimização em andamento.');
  optimizing = true;
  try {
    const depot = db.depot, best = plan(depot, vs, ps), base = baselineKm(depot, vs, ps);
    for (const d of db.deliveries) if (d.status === 'pendente') { d.vehicleId = null; d.order = 0; d.etaMin = null; d.legKm = null; }
    db.routes = {};
    let roadKm = 0, roadFailed = 0;
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i], order = best.orders[i];
      order.forEach((d, j) => { d.vehicleId = v.id; d.order = j + 1; });
      if (!order.length) continue;
      const start = best.starts[i];
      try {
        const rt = await osrmRoute([start, ...order, depot]);
        let cum = 0;
        order.forEach((d, j) => { cum += rt.legs[j].durationS / 60; d.etaMin = Math.round(cum); d.legKm = rt.legs[j].distanceM / 1000; cum += SERVICE_MIN; });
        db.routes[v.id] = { geometry: rt.geometry, distanceM: rt.distanceM, durationS: rt.durationS + order.length * SERVICE_MIN * 60 };
        roadKm += rt.distanceM / 1000;
      } catch (e) {
        roadFailed++;
        let cum = 0, cur = start;
        order.forEach(d => { const km = dist(cur, d); cum += km / SPEED_KMH * 60; d.etaMin = Math.round(cum); d.legKm = km; cum += SERVICE_MIN; cur = d; });
        db.routes[v.id] = { geometry: [[start.lat, start.lng], ...order.map(d => [d.lat, d.lng]), [depot.lat, depot.lng]], distanceM: pathKm(start, order, depot) * 1000, durationS: cum * 60, straight: true };
      }
    }
    db.summary = { baselineKm: base, optimizedKm: best.km, roadKm: roadFailed ? null : roadKm, roadFailed, stops: ps.length, vehicles: vs.length, at: Date.now() };
    changed();
    broadcast('routes', { at: Date.now() });
    return db.summary;
  } finally { optimizing = false; }
}

/* ---------------- API do despachante ---------------- */
function vehicleView(body, v) {
  const name = str(body.name, 40), plate = str(body.plate, 12).toUpperCase(), driver = str(body.driver, 60);
  if (v) { if (name) v.name = name; if (body.plate !== undefined) v.plate = plate; if (body.driver !== undefined) v.driver = driver; if (typeof body.active === 'boolean') v.active = body.active; return v; }
  if (!name) throw new HttpError(400, 'Informe o nome do veículo.');
  return { id: uid(), name, plate, driver, token: crypto.randomBytes(12).toString('hex'), active: true, lat: null, lng: null, status: 'livre', updatedAt: null };
}
function newDelivery(row, now) {
  const address = str(row.address, 300);
  if (!address) return null;
  const d = {
    id: uid(), client: str(row.client, 120) || 'Sem nome', address, notes: str(row.notes, 300),
    priority: row.priority === 'alta' ? 'alta' : 'normal', clientId: '', code: '', lat: null, lng: null, label: '', approx: false,
    geoStatus: 'pendente', geoError: '', vehicleId: null, order: 0, etaMin: null, legKm: null, status: 'pendente', deliveredAt: null, createdAt: now
  };
  const lat = num(row.lat), lng = num(row.lng);
  if (validLat(lat) && validLng(lng)) { d.lat = lat; d.lng = lng; d.geoStatus = 'ok'; d.label = str(row.label, 300); }
  else {
    const hit = db.geocache['g2:' + withSuffix(address).toLowerCase()];
    if (hit) { Object.assign(d, { lat: hit.lat, lng: hit.lng, label: hit.label, approx: hit.approx, geoStatus: 'ok' }); }
  }
  return d;
}
async function adminApi(req, res, url, p) {
  const m = req.method;
  let mm;
  if (p === '/api/events' && m === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 3000\n\n');
    clients.add(res);
    res.write('event: state\ndata: ' + JSON.stringify(publicState()) + '\n\n');
    req.on('close', () => clients.delete(res));
    return;
  }
  if (p === '/api/state' && m === 'GET') return json(res, 200, publicState());
  if (p === '/api/routes' && m === 'GET') return json(res, 200, db.routes);

  if (p === '/api/geocode' && m === 'GET') {
    const q = str(url.searchParams.get('q') || '', 200);
    if (q.length < 4) throw new HttpError(400, 'Digite o endereço completo para buscar.');
    try { return json(res, 200, { results: (await searchChain(q, 5)).results }); }
    catch (e) { throw new HttpError(502, 'Serviço de busca de endereços indisponível.'); }
  }
  if (p === '/api/route' && m === 'GET') {
    const parse = s => { const [a, b] = String(s || '').split(',').map(Number); return { lat: a, lng: b }; };
    const from = parse(url.searchParams.get('from')), to = parse(url.searchParams.get('to'));
    if (![from, to].every(x => validLat(x.lat) && validLng(x.lng))) throw new HttpError(400, 'Coordenadas inválidas.');
    try { const rt = await osrmRoute([from, to]); return json(res, 200, { distanceM: rt.distanceM, durationS: rt.durationS, geometry: rt.geometry }); }
    catch (e) { throw new HttpError(502, 'Serviço de rotas indisponível.'); }
  }
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    if (b.suffix !== undefined) db.settings.suffix = str(b.suffix, 100);
    const address = str(b.depotAddress, 300);
    if (address) {
      let lat = num(b.depotLat), lng = num(b.depotLng), label = str(b.depotLabel, 300);
      if (!(validLat(lat) && validLng(lng))) {
        let r; try { r = await geocodeAddress(address, true); } catch (e) { throw new HttpError(502, 'Serviço de busca de endereços indisponível.'); }
        if (!r) throw new HttpError(404, 'Não encontramos o endereço do depósito. Confira o endereço ou use "Marcar no mapa".');
        lat = r.lat; lng = r.lng; label = r.label;
      }
      db.depot = { address, lat, lng, label };
    }
    changed();
    return json(res, 200, publicState());
  }
  if (p === '/api/vehicles' && m === 'POST') {
    const v = vehicleView(await readBody(req));
    db.vehicles.push(v); changed(); return json(res, 201, v);
  }
  if ((mm = p.match(/^\/api\/vehicles\/([a-f0-9]+)$/))) {
    const v = db.vehicles.find(x => x.id === mm[1]);
    if (!v) throw new HttpError(404, 'Veículo não encontrado.');
    if (m === 'PATCH') { vehicleView(await readBody(req), v); changed(); return json(res, 200, v); }
    if (m === 'DELETE') {
      db.vehicles = db.vehicles.filter(x => x.id !== v.id);
      for (const d of db.deliveries) if (d.vehicleId === v.id && d.status === 'pendente') { d.vehicleId = null; d.order = 0; d.etaMin = null; d.legKm = null; }
      delete db.routes[v.id]; changed(); broadcast('routes', { at: Date.now() });
      return json(res, 200, { ok: true });
    }
  }
  if (p === '/api/deliveries' && m === 'POST') {
    const b = await readBody(req);
    const d = newDelivery(b, Date.now());
    if (!d) throw new HttpError(400, 'Informe o endereço da entrega.');
    const c = db.clients.find(x => x.id === str(b.clientId, 40));
    if (c) {
      if (db.deliveries.some(x => x.clientId === c.id && x.status === 'pendente')) throw new HttpError(409, c.name + ' já está nas entregas de hoje.');
      d.clientId = c.id; d.code = c.code || '';
      if (d.geoStatus !== 'ok' && c.geoStatus === 'ok') Object.assign(d, { lat: c.lat, lng: c.lng, label: c.label, approx: c.approx, geoStatus: 'ok', geoError: '' });
    }
    db.deliveries.push(d); changed();
    if (d.geoStatus === 'pendente') runGeo(d.id);
    return json(res, 201, d);
  }
  if (p === '/api/deliveries/import' && m === 'POST') {
    const b = await readBody(req, 12e6);
    if (!Array.isArray(b.rows)) throw new HttpError(400, 'Nenhuma linha para importar.');
    const now = Date.now(); let skipped = 0; const created = [];
    b.rows.slice(0, 3000).forEach((row, i) => { const d = newDelivery(row || {}, now + i); if (d) created.push(d); else skipped++; });
    db.deliveries.push(...created); changed();
    created.filter(d => d.geoStatus === 'pendente').forEach(d => runGeo(d.id));
    return json(res, 200, { created: created.length, skipped, truncated: b.rows.length > 3000 });
  }
  if ((mm = p.match(/^\/api\/deliveries\/([a-f0-9]+)$/))) {
    const d = db.deliveries.find(x => x.id === mm[1]);
    if (!d) throw new HttpError(404, 'Entrega não encontrada.');
    if (m === 'DELETE') { db.deliveries = db.deliveries.filter(x => x.id !== d.id); changed(); return json(res, 200, { ok: true }); }
    if (m === 'PATCH') {
      const b = await readBody(req);
      if (b.client !== undefined) d.client = str(b.client, 120) || d.client;
      if (b.notes !== undefined) d.notes = str(b.notes, 300);
      if (b.priority !== undefined) d.priority = b.priority === 'alta' ? 'alta' : 'normal';
      const lat = num(b.lat), lng = num(b.lng);
      if (b.address !== undefined && str(b.address, 300)) {
        d.address = str(b.address, 300); d.vehicleId = null; d.order = 0; d.etaMin = null; d.legKm = null;
        if (validLat(lat) && validLng(lng)) { Object.assign(d, { lat, lng, label: str(b.label, 300), approx: false, geoStatus: 'ok', geoError: '' }); }
        else { Object.assign(d, { lat: null, lng: null, geoStatus: 'pendente', geoError: '' }); runGeo(d.id, true); }
      } else if (b.retry === true && d.geoStatus === 'falhou') { d.geoStatus = 'pendente'; runGeo(d.id, true); }
      changed(); return json(res, 200, d);
    }
  }
  if (p === '/api/clients/search' && m === 'GET') {
    const q = norm(str(url.searchParams.get('q') || '', 80));
    if (!q) return json(res, 200, { results: [] });
    const inRoute = new Set(db.deliveries.filter(d => d.status === 'pendente' && d.clientId).map(d => d.clientId));
    const scored = [];
    for (const c of db.clients) {
      const code = norm(c.code), name = norm(c.name); let s = 9;
      if (code && code === q) s = 0;
      else if (code && code.startsWith(q)) s = 1;
      else if (name.startsWith(q)) s = 2;
      else if (name.split(/\s+/).some(w => w.startsWith(q))) s = 3;
      else if (name.includes(q)) s = 4;
      else if (q.length >= 3 && norm(c.address).includes(q)) s = 5;
      if (s < 9) scored.push([s, c]);
    }
    scored.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'pt-BR'));
    return json(res, 200, { results: scored.slice(0, 8).map(([, c]) => ({ id: c.id, code: c.code, name: c.name, address: c.address, notes: c.notes, lat: c.lat, lng: c.lng, label: c.label, approx: c.approx, geoStatus: c.geoStatus, geoSource: c.geoSource || '', inRoute: inRoute.has(c.id) })) });
  }
  if (p === '/api/clients/import' && m === 'POST') {
    const b = await readBody(req, 14e6);
    if (!Array.isArray(b.rows)) throw new HttpError(400, 'Nenhuma linha para importar.');
    const byCode = new Map(), byKey = new Map();
    for (const c of db.clients) { if (c.code) byCode.set(norm(c.code), c); byKey.set(norm(c.name) + '|' + (c.sig || norm(c.address)), c); }
    const now = Date.now(), touched = [], skippedNames = []; let created = 0, updated = 0, skipped = 0, delivered = 0;
    b.rows.slice(0, 20000).forEach((row, i) => {
      const f = clientFields(row || {});
      if (!clientUsable(f)) { skipped++; if (skippedNames.length < 10) skippedNames.push(f.name); return; }
      f.address = Clean.fmtAddress(f); f.sig = clientSig(f);
      let c = (f.code && byCode.get(norm(f.code))) || byKey.get(norm(f.name) + '|' + f.sig);
      if (c) {
        const same = c.sig === f.sig;
        Object.assign(c, { code: f.code || c.code, name: f.name, notes: f.notes });
        if (!same) Object.assign(c, f, { lat: null, lng: null, label: '', approx: false, geoStatus: 'pendente', geoError: '', geoSource: '' });
        updated++;
      } else {
        c = { id: uid(), ...f, lat: null, lng: null, label: '', approx: false, geoStatus: 'pendente', geoError: '', geoSource: '', createdAt: now + i };
        db.clients.push(c); created++;
        if (f.code) byCode.set(norm(f.code), c);
        byKey.set(norm(f.name) + '|' + f.sig, c);
      }
      touched.push(c);
    });
    if (b.alsoDeliver === true) for (const c of touched) if (addClientDelivery(c, now)) delivered++;
    changed();
    touched.filter(c => c.geoStatus === 'pendente').forEach(c => enqueueClientGeo(c.id));
    return json(res, 200, { created, updated, skipped, skippedNames, delivered, truncated: b.rows.length > 20000 });
  }
  if (p === '/api/clients/failed' && m === 'GET') {
    const list = db.clients.filter(c => c.geoStatus === 'falhou');
    return json(res, 200, { total: list.length, clients: list.slice(0, 100).map(c => ({ id: c.id, code: c.code, name: c.name, address: c.address, street: c.raw || '', bairro: c.bairro, cep: c.cep, error: c.geoError })) });
  }
  if ((mm = p.match(/^\/api\/clients\/([a-f0-9]+)$/))) {
    const c = db.clients.find(x => x.id === mm[1]);
    if (!c) throw new HttpError(404, 'Cliente não encontrado.');
    if (m === 'DELETE') { db.clients = db.clients.filter(x => x.id !== c.id); changed(); return json(res, 200, { ok: true }); }
    if (m === 'PATCH') {
      const b = await readBody(req, 5000), lat = num(b.lat), lng = num(b.lng);
      if (validLat(lat) && validLng(lng)) Object.assign(c, { lat, lng, label: 'Ponto marcado no mapa', approx: false, geoStatus: 'ok', geoError: '', geoSource: 'manual' });
      else if (b.street !== undefined || b.bairro !== undefined || b.cep !== undefined) {
        const f = clientFields({ code: c.code, client: c.name, street: b.street !== undefined ? b.street : c.raw, bairro: b.bairro !== undefined ? b.bairro : c.bairro, cep: b.cep !== undefined ? b.cep : c.cep, city: c.city, uf: c.uf, notes: c.notes });
        if (!clientUsable(f)) throw new HttpError(400, 'Informe a rua e o número ou um CEP completo.');
        f.address = Clean.fmtAddress(f); f.sig = clientSig(f);
        Object.assign(c, f, { lat: null, lng: null, label: '', approx: false, geoStatus: 'pendente', geoError: '', geoSource: '' });
        enqueueClientGeo(c.id);
      } else if (b.retry === true) { Object.assign(c, { geoStatus: 'pendente', geoError: '' }); enqueueClientGeo(c.id); }
      else throw new HttpError(400, 'Nada para alterar.');
      applyClientGeo(c); changed(); return json(res, 200, { ok: true });
    }
  }
  if (p === '/api/clients/clear' && m === 'POST') { db.clients = []; changed(); return json(res, 200, { ok: true }); }
  if (p === '/api/optimize' && m === 'POST') return json(res, 200, await optimize());
  if (p === '/api/clear-day' && m === 'POST') {
    db.deliveries = []; db.routes = {}; db.summary = null;
    for (const v of db.vehicles) v.status = 'livre';
    changed(); broadcast('routes', { at: Date.now() });
    return json(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Não encontrado.');
}

/* ---------------- API do motorista (acesso por link pessoal) ---------------- */
async function driverApi(req, res, token, action) {
  const v = db.vehicles.find(x => x.token === token);
  if (!v) throw new HttpError(404, 'Link inválido. Peça um novo link ao despachante.');
  const m = req.method;
  const pending = () => db.deliveries.filter(d => d.vehicleId === v.id && d.status === 'pendente').sort((a, b) => a.order - b.order);
  if (!action && m === 'GET') {
    const mine = db.deliveries.filter(d => d.vehicleId === v.id).sort((a, b) => a.order - b.order)
      .map(d => ({ id: d.id, client: d.client, address: d.address, notes: d.notes, priority: d.priority, lat: d.lat, lng: d.lng, order: d.order, etaMin: d.etaMin, legKm: d.legKm, status: d.status, deliveredAt: d.deliveredAt }));
    return json(res, 200, { vehicle: { name: v.name, plate: v.plate, driver: v.driver, active: v.active }, depot: db.depot ? { lat: db.depot.lat, lng: db.depot.lng } : null, stops: mine });
  }
  if (action === 'position' && m === 'POST') {
    const b = await readBody(req, 2000), lat = num(b.lat), lng = num(b.lng);
    if (!(validLat(lat) && validLng(lng))) throw new HttpError(400, 'Posição inválida.');
    v.lat = lat; v.lng = lng; v.updatedAt = Date.now();
    v.status = pending().length ? 'em_rota' : 'livre';
    changed(); return json(res, 200, { ok: true });
  }
  if (action === 'deliver' && m === 'POST') {
    const b = await readBody(req, 2000);
    const d = db.deliveries.find(x => x.id === str(b.id, 40) && x.vehicleId === v.id);
    if (!d) throw new HttpError(404, 'Entrega não encontrada neste veículo.');
    if (d.status !== 'entregue') { d.status = 'entregue'; d.deliveredAt = Date.now(); }
    v.status = pending().length ? 'em_rota' : 'livre';
    changed(); return json(res, 200, { ok: true });
  }
  throw new HttpError(404, 'Não encontrado.');
}

/* ---------------- arquivos estáticos ---------------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function sendFile(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) throw new HttpError(404, 'Não encontrado.');
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { throw new HttpError(404, 'Não encontrado.'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost'), p = url.pathname;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (p === '/healthz') return json(res, 200, { ok: true });
    let m;
    if ((m = p.match(/^\/m\/([a-f0-9]{16,64})$/)) && req.method === 'GET') return sendFile(res, 'motorista.html');
    if ((m = p.match(/^\/api\/driver\/([a-f0-9]{16,64})(?:\/(position|deliver))?$/))) return await driverApi(req, res, m[1], m[2]);
    if (!isAdmin(req)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Painel de Rotas", charset="UTF-8"', 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Acesso restrito. Informe a senha do painel.');
    }
    if (p.startsWith('/api/')) return await adminApi(req, res, url, p);
    if (req.method !== 'GET') throw new HttpError(405, 'Método não permitido.');
    return sendFile(res, p === '/' ? 'index.html' : p.slice(1));
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return json(res, e.code, { error: e.message });
    console.error(e);
    return json(res, 500, { error: 'Erro interno do servidor.' });
  }
});

(async () => {
  try {
    const saved = await store.load();
    if (saved) db = { ...db, ...saved };
  } catch (e) {
    console.error('Não foi possível carregar os dados (' + store.kind + '): ' + e.message);
    process.exit(1);
  }
  server.listen(PORT, () => {
    console.log('Painel de Rotas em http://localhost:' + PORT + ' (dados: ' + store.kind + ')' + (ADMIN_PASSWORD ? '' : '  (ATENÇÃO: sem senha. Defina ADMIN_PASSWORD antes de publicar.)'));
    if (store.temporary) console.error('ATENÇÃO: sem DATABASE_URL, os dados ficam num arquivo temporário e serão apagados quando o servidor reiniciar.');
    resumePending();
  });
})();
