'use strict';
/* Painel do despachante: mapa, entregas, importação de planilha e frota. */
const $ = s => document.querySelector(s);
function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'class') n.className = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) { if (c == null || c === false) continue; n.append(c.nodeType ? c : document.createTextNode(String(c))); }
  return n;
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  let j = {}; try { j = await r.json(); } catch (e) { /* sem corpo */ }
  if (!r.ok) throw new Error(j.error || 'Erro ' + r.status);
  return j;
}
const fmtKm = km => km.toFixed(1).replace('.', ',') + ' km';
const fmtMin = m => (m < 60 ? Math.round(m) + ' min' : Math.floor(m / 60) + ' h ' + String(Math.round(m % 60)).padStart(2, '0'));
const fmtHour = t => new Date(t).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
let toastT = null;
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 4200); }

let S = { vehicles: [], deliveries: [], depot: null, settings: { suffix: '' }, summary: null, geoPending: 0 };
let routes = {};
let gotState = false;
const COLORS = ['#1456d6', '#d9570b', '#128a4f', '#8a3fd1', '#0b8aa6', '#c2185b', '#7a6a00', '#455a64'];
const colorOf = id => { const i = S.vehicles.findIndex(v => v.id === id); return i < 0 ? '#7b8a96' : COLORS[i % COLORS.length]; };
const STALE_MS = 120000;

/* ---------------- mapa ---------------- */
const map = L.map('map').setView([-15.78, -47.93], 4);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '© OpenStreetMap', referrerPolicy: 'origin' }).addTo(map);
const gRoutes = L.layerGroup().addTo(map), gDel = L.layerGroup().addTo(map), gPrev = L.layerGroup().addTo(map), gVeh = L.layerGroup().addTo(map);
let depotMarker = null, fitted = false, lastDelKey = '', lastVehIds = '';
const delMarkers = new Map(), vehMarkers = new Map();
const pinIcon = (txt, color, cls) => L.divIcon({ className: '', html: '<div class="pin ' + (cls || '') + '" style="--c:' + esc(color) + '">' + esc(txt) + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });

function fitAll() {
  const pts = [];
  if (S.depot) pts.push([S.depot.lat, S.depot.lng]);
  S.deliveries.forEach(d => { if (d.geoStatus === 'ok') pts.push([d.lat, d.lng]); });
  if (pts.length) { map.fitBounds(L.latLngBounds(pts).pad(0.15), { maxZoom: 15 }); fitted = true; }
}
function drawRoutes() {
  gRoutes.clearLayers();
  for (const [vid, r] of Object.entries(routes)) {
    if (!S.vehicles.some(v => v.id === vid)) continue;
    L.polyline(r.geometry, { color: colorOf(vid), weight: 5, opacity: 0.8, dashArray: r.straight ? '6 8' : null }).addTo(gRoutes);
  }
}
async function loadRoutes() { try { routes = await api('GET', '/api/routes'); drawRoutes(); renderKpis(); renderFleet(); } catch (e) { /* tenta de novo no próximo evento */ } }

function renderMap() {
  if (S.depot) {
    if (!depotMarker) depotMarker = L.marker([S.depot.lat, S.depot.lng], { icon: pinIcon('D', '#12202b', 'deposito'), zIndexOffset: 500 }).addTo(map).bindTooltip('Depósito');
    else depotMarker.setLatLng([S.depot.lat, S.depot.lng]);
  }
  const ids = S.vehicles.map(v => v.id).join(',');
  if (ids !== lastVehIds) { lastVehIds = ids; drawRoutes(); }
  const key = S.deliveries.map(d => [d.id, d.order, d.status, d.vehicleId, d.lat, d.lng, d.priority, d.geoStatus].join()).join('|') + '#' + ids;
  if (key !== lastDelKey) {
    lastDelKey = key; gDel.clearLayers(); delMarkers.clear();
    for (const d of S.deliveries) {
      if (d.geoStatus !== 'ok') continue;
      const done = d.status === 'entregue';
      const cls = (d.priority === 'alta' && !done ? 'alta ' : '') + (done ? 'done' : '');
      const m = L.marker([d.lat, d.lng], { icon: pinIcon(done ? '✓' : (d.order || '·'), done ? '#7b8a96' : colorOf(d.vehicleId), cls) }).addTo(gDel);
      const veh = S.vehicles.find(v => v.id === d.vehicleId);
      m.bindPopup(h('div', {}, h('b', {}, d.client), h('br'), d.address, d.notes ? h('div', {}, d.notes) : null,
        h('div', { class: 'hint' }, veh ? veh.name + (d.etaMin != null && !done ? ' · chegada em ' + fmtMin(d.etaMin) : '') : 'Sem rota')));
      delMarkers.set(d.id, m);
    }
  }
  updateVehicleMarkers();
  if (!fitted && (S.depot || S.deliveries.some(d => d.geoStatus === 'ok'))) fitAll();
}
function updateVehicleMarkers() {
  const present = new Set();
  for (const v of S.vehicles) {
    if (v.lat == null || v.lng == null) continue;
    present.add(v.id);
    const stale = !v.updatedAt || Date.now() - v.updatedAt > STALE_MS;
    const icon = L.divIcon({ className: '', html: '<div class="vmark' + (stale ? ' stale' : '') + '" style="--c:' + esc(colorOf(v.id)) + '">' + esc(v.name) + '</div>', iconSize: [0, 0] });
    let m = vehMarkers.get(v.id);
    if (!m) { m = L.marker([v.lat, v.lng], { icon, zIndexOffset: 1000 }).addTo(gVeh); vehMarkers.set(v.id, m); }
    else { m.setLatLng([v.lat, v.lng]); m.setIcon(icon); }
    m.bindTooltip(v.name + (v.driver ? ' · ' + v.driver : '') + (v.plate ? ' · ' + v.plate : ''));
  }
  for (const [id, m] of vehMarkers) if (!present.has(id)) { gVeh.removeLayer(m); vehMarkers.delete(id); }
}

/* ---------------- indicadores ---------------- */
function pendingOf(v) { return S.deliveries.filter(d => d.vehicleId === v.id && d.status === 'pendente'); }
function renderKpis() {
  const total = S.deliveries.length, done = S.deliveries.filter(d => d.status === 'entregue').length;
  const onRoad = S.vehicles.filter(v => v.active && v.status === 'em_rota').length;
  let km = 0; for (const v of S.vehicles) if (routes[v.id] && pendingOf(v).length) km += routes[v.id].distanceM / 1000;
  let eco = '–', ecoS = '';
  if (S.summary && S.summary.baselineKm > 0) { const p = Math.round((1 - S.summary.optimizedKm / S.summary.baselineKm) * 100); eco = (p > 0 ? '−' : '+') + Math.abs(p) + '%'; ecoS = 'estimado'; }
  const item = (t, v, s) => h('div', {}, h('dt', {}, t), h('dd', {}, v, s ? h('small', {}, s) : null));
  $('#kpis').replaceChildren(item('Entregas', done + '/' + total, 'concluídas'), item('Veículos em rota', String(onRoad), 'de ' + S.vehicles.filter(v => v.active).length),
    item('Km nas ruas', fmtKm(km)), item('Economia', eco, ecoS));
}
function renderSummary() {
  const s = $('#summary'), m = S.summary;
  if (!m) { s.hidden = true; return; }
  s.hidden = false;
  const p = Math.round((1 - m.optimizedKm / m.baselineKm) * 100);
  s.replaceChildren('Última otimização às ' + fmtHour(m.at) + ': ', h('b', {}, m.stops + ' paradas em ' + m.vehicles + ' veículos'), '. ',
    m.roadKm != null ? h('b', {}, fmtKm(m.roadKm) + ' pelas ruas') : h('b', {}, 'rota pelas ruas indisponível (usando linha reta)'),
    '. Estimativa de ' + fmtKm(m.optimizedKm) + ' contra ' + fmtKm(m.baselineKm) + ' sem roteirização (' + (p > 0 ? '−' : '+') + Math.abs(p) + '%).');
}

/* ---------------- lista de entregas ---------------- */
let selected = null, editingDelivery = null, chosen = null;
function deliveryRow(d, vc) {
  const done = d.status === 'entregue', failed = d.geoStatus === 'falhou', locating = d.geoStatus === 'pendente';
  return h('div', { class: 'row' + (done ? ' done' : ''), style: '--vc:' + (vc || '#7b8a96'), onclick: () => focusDelivery(d) },
    h('span', { class: 'num' }, done ? '✓' : (d.order || '·')),
    h('div', {}, h('div', { class: 'who' }, d.code ? h('span', { class: 'code' }, d.code) : null, d.client), h('div', { class: 'addr' }, d.address),
      h('div', { class: 'chips' },
        d.priority === 'alta' ? h('span', { class: 'chip alta' }, 'Prioridade alta') : null,
        locating ? h('span', { class: 'chip' }, 'Localizando…') : null,
        failed ? h('span', { class: 'chip warn' }, d.geoError || 'Não encontrado') : null,
        d.approx ? h('span', { class: 'chip warn', title: 'O número não foi encontrado; o ponto é da rua.' }, 'Posição aproximada') : null,
        done ? h('span', { class: 'chip ok' }, 'Entregue às ' + fmtHour(d.deliveredAt)) : null)),
    h('div', { class: 'right' },
      !done && d.etaMin != null ? 'em ' + fmtMin(d.etaMin) : null,
      h('div', { class: 'mini' },
        failed ? h('button', { type: 'button', title: 'Tentar localizar de novo', 'aria-label': 'Tentar localizar de novo', onclick: e => { e.stopPropagation(); api('PATCH', '/api/deliveries/' + d.id, { retry: true }).catch(x => toast(x.message)); } }, '↻') : null,
        !done ? h('button', { type: 'button', title: 'Editar', 'aria-label': 'Editar entrega de ' + d.client, onclick: e => { e.stopPropagation(); startEdit(d); } }, '✎') : null,
        h('button', { type: 'button', title: 'Remover', 'aria-label': 'Remover entrega de ' + d.client, onclick: e => { e.stopPropagation(); if (confirm('Remover a entrega de ' + d.client + '?')) api('DELETE', '/api/deliveries/' + d.id).catch(x => toast(x.message)); } }, '×'))));
}
function focusDelivery(d) {
  selected = d.id;
  const m = delMarkers.get(d.id);
  if (m) { map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.6 }); m.openPopup(); }
}
function renderList() {
  const box = $('#dlist'); box.replaceChildren();
  if (!S.deliveries.length) { box.append(h('div', { class: 'empty' }, 'Nenhuma entrega ainda. Adicione uma entrega acima ou importe a planilha do seu sistema na aba Importar.')); return; }
  for (const v of S.vehicles) {
    const ds = S.deliveries.filter(d => d.vehicleId === v.id).sort((a, b) => a.order - b.order);
    if (!ds.length) continue;
    const r = routes[v.id], pend = ds.filter(d => d.status === 'pendente').length;
    box.append(h('div', { class: 'grp', style: '--c:' + colorOf(v.id) },
      h('div', { class: 'grp-h' }, h('h2', {}, v.name + (v.driver ? ' · ' + v.driver : '')),
        h('span', { class: 'meta' }, (ds.length - pend) + '/' + ds.length + ' entregues' + (r && pend ? ' · ' + fmtKm(r.distanceM / 1000) + ' · ' + fmtMin(r.durationS / 60) : ''))),
      ds.map(d => deliveryRow(d, colorOf(v.id)))));
  }
  const loose = S.deliveries.filter(d => d.geoStatus === 'ok' && d.status === 'pendente' && !S.vehicles.some(v => v.id === d.vehicleId));
  if (loose.length) box.append(h('div', { class: 'grp' }, h('div', { class: 'grp-h' }, h('h2', {}, 'Sem rota'), h('span', { class: 'meta' }, loose.length + ' aguardando otimização')), loose.map(d => deliveryRow(d))));
  const geo = S.deliveries.filter(d => d.geoStatus !== 'ok');
  if (geo.length) box.append(h('div', { class: 'grp' }, h('div', { class: 'grp-h' }, h('h2', {}, 'Endereço não localizado'), h('span', { class: 'meta' }, geo.length + ' para conferir')), geo.map(d => deliveryRow(d))));
}

/* ---------------- formulário de entrega com busca ---------------- */
async function doSearch() {
  const q = $('#f-addr').value.trim();
  if (q.length < 4) return toast('Digite o endereço completo para buscar.');
  const b = $('#btn-search'); b.disabled = true; b.textContent = 'Buscando…';
  try {
    const { results } = await api('GET', '/api/geocode?q=' + encodeURIComponent(q));
    renderResults(results);
  } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = 'Buscar'; }
}
function renderResults(results) {
  const box = $('#results'); box.replaceChildren();
  if (!results.length) { box.append(h('p', { class: 'hint warn' }, 'Nenhum resultado. Tente incluir cidade e estado. Você também pode adicionar a entrega mesmo assim e o sistema tenta localizar depois.')); return; }
  results.forEach(r => {
    const b = h('button', { type: 'button', 'aria-pressed': 'false', onclick: () => selectResult(r, b) }, r.label + (r.approx ? ' (posição aproximada da rua)' : ''));
    box.append(b);
  });
  if (results.length === 1) box.firstChild.click();
}
async function selectResult(r, btn) {
  chosen = r;
  $('#results').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x === btn)));
  gPrev.clearLayers();
  L.marker([r.lat, r.lng], { icon: pinIcon('?', '#1456d6') }).addTo(gPrev);
  const pv = $('#preview'); pv.hidden = false; pv.textContent = 'Calculando rota a partir do depósito…';
  if (!S.depot) { pv.textContent = 'Defina o depósito na aba Frota para ver a rota.'; map.flyTo([r.lat, r.lng], 16); return; }
  try {
    const rt = await api('GET', '/api/route?from=' + S.depot.lat + ',' + S.depot.lng + '&to=' + r.lat + ',' + r.lng);
    if (chosen !== r) return;
    L.polyline(rt.geometry, { color: '#1456d6', weight: 5, opacity: 0.85, dashArray: '8 8' }).addTo(gPrev);
    pv.textContent = 'Do depósito: ' + fmtKm(rt.distanceM / 1000) + ' · ' + fmtMin(rt.durationS / 60) + ' de carro';
    map.fitBounds(L.latLngBounds(rt.geometry).pad(0.2));
  } catch (e) { pv.textContent = 'Não foi possível calcular a rota agora. ' + e.message; map.flyTo([r.lat, r.lng], 16); }
}
function resetDeliveryForm() {
  editingDelivery = null; chosen = null; pickedClient = null; if (typeof closeSugg === 'function') closeSugg();
  $('#dform').reset(); $('#results').replaceChildren(); $('#preview').hidden = true; gPrev.clearLayers();
  $('#addsum').textContent = 'Nova entrega'; $('#btn-add').textContent = 'Adicionar entrega'; $('#btn-cancel').hidden = true;
}
function startEdit(d) {
  editingDelivery = d; chosen = null;
  $('#addbox').open = true; $('#f-client').value = d.client; $('#f-addr').value = d.address; $('#f-prio').value = d.priority; $('#f-notes').value = d.notes || '';
  $('#results').replaceChildren(); $('#preview').hidden = true; gPrev.clearLayers();
  $('#addsum').textContent = 'Corrigir entrega'; $('#btn-add').textContent = 'Salvar correção'; $('#btn-cancel').hidden = false;
  $('#f-addr').focus(); $('#addbox').scrollIntoView({ block: 'nearest' });
}
$('#btn-search').addEventListener('click', doSearch);
$('#f-addr').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
$('#f-addr').addEventListener('input', () => { chosen = null; $('#results').querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', 'false')); });
$('#btn-cancel').addEventListener('click', resetDeliveryForm);
$('#dform').addEventListener('submit', async e => {
  e.preventDefault();
  const client = $('#f-client').value.trim(), address = $('#f-addr').value.trim();
  if (!address) return toast('Informe o endereço da entrega.');
  const body = { client, address, priority: $('#f-prio').value, notes: $('#f-notes').value.trim() };
  if (chosen) Object.assign(body, { lat: chosen.lat, lng: chosen.lng, label: chosen.label });
  if (pickedClient && !editingDelivery) body.clientId = pickedClient.id;
  const b = $('#btn-add'); b.disabled = true;
  try {
    if (editingDelivery) {
      const d = editingDelivery;
      if (address === d.address && !chosen && d.geoStatus === 'ok') delete body.address;
      await api('PATCH', '/api/deliveries/' + d.id, body);
      toast('Entrega atualizada. Gere as rotas de novo para refletir a mudança.');
    } else {
      await api('POST', '/api/deliveries', body);
      toast(chosen ? 'Entrega adicionada. Use "Otimizar rotas" para incluí-la.' : 'Entrega adicionada. O sistema está localizando o endereço.');
    }
    resetDeliveryForm();
  } catch (err) { toast(err.message); } finally { b.disabled = false; }
});
$('#btn-clear').addEventListener('click', async () => {
  if (!confirm('Apagar todas as entregas e rotas do dia? Os veículos e o depósito continuam cadastrados.')) return;
  try { await api('POST', '/api/clear-day'); routes = {}; drawRoutes(); toast('Entregas do dia apagadas.'); } catch (e) { toast(e.message); }
});
$('#btn-opt').addEventListener('click', async () => {
  const b = $('#btn-opt'); b.disabled = true; b.textContent = 'Calculando rotas…';
  try {
    const s = await api('POST', '/api/optimize');
    await loadRoutes(); fitAll();
    toast('Rotas geradas para ' + s.stops + ' entregas em ' + s.vehicles + ' veículos.');
  } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = 'Otimizar rotas'; }
});

/* ---------------- frota e depósito ---------------- */
let editingVehicle = null, settingsInit = false;
function ago(t) { if (!t) return null; const m = Math.round((Date.now() - t) / 60000); return m < 1 ? 'agora' : 'há ' + m + ' min'; }
function renderFleet() {
  const box = $('#vlist'); box.replaceChildren();
  if (!S.vehicles.length) box.append(h('div', { class: 'empty' }, 'Nenhum veículo cadastrado. Use o formulário abaixo.'));
  for (const v of S.vehicles) {
    const all = S.deliveries.filter(d => d.vehicleId === v.id), pend = all.filter(d => d.status === 'pendente').length, r = routes[v.id];
    const stale = !v.updatedAt || Date.now() - v.updatedAt > STALE_MS;
    const link = location.origin + '/m/' + v.token;
    const input = h('input', { readonly: true, value: link, 'aria-label': 'Link do motorista de ' + v.name, onfocus: e => e.target.select() });
    box.append(h('div', { class: 'vcard' + (v.active ? '' : ' off'), style: '--c:' + colorOf(v.id) },
      h('div', { class: 'vhead' }, h('h2', {}, v.name), v.plate ? h('span', { class: 'plate' }, v.plate) : null, h('span', { class: 'hint' }, v.driver || 'Sem motorista')),
      h('div', { class: 'chips', style: 'margin:0' },
        h('span', { class: 'chip' + (v.status === 'em_rota' ? ' next' : '') }, v.active ? (v.status === 'em_rota' ? 'Em rota' : 'Disponível') : 'Fora de serviço'),
        v.updatedAt ? h('span', { class: 'chip' + (stale ? ' warn' : ' ok') }, (stale ? 'Sem sinal ' : 'Sinal ') + ago(v.updatedAt)) : h('span', { class: 'chip' }, 'Ainda sem sinal de GPS')),
      h('p', { class: 'hint' }, all.length ? (all.length - pend) + '/' + all.length + ' entregues' + (r && pend ? ' · ' + fmtKm(r.distanceM / 1000) + ' · ' + fmtMin(r.durationS / 60) : '') : 'Sem entregas atribuídas'),
      h('div', { class: 'field' }, h('label', {}, 'Link do motorista (abra no celular dele)'),
        h('div', { class: 'linkbox' }, input, h('button', { class: 'btn small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast('Link copiado.'); } catch (e) { input.select(); toast('Selecionei o link. Use copiar do celular.'); } } }, 'Copiar'))),
      h('div', { class: 'inline' },
        h('button', { class: 'btn small', type: 'button', onclick: () => startEditVehicle(v) }, 'Editar'),
        h('button', { class: 'btn small', type: 'button', onclick: () => api('PATCH', '/api/vehicles/' + v.id, { active: !v.active }).catch(e => toast(e.message)) }, v.active ? 'Tirar de serviço' : 'Colocar em serviço'),
        h('button', { class: 'btn small', type: 'button', onclick: () => { if (confirm('Remover o veículo ' + v.name + '? As entregas pendentes dele ficam sem rota.')) api('DELETE', '/api/vehicles/' + v.id).catch(e => toast(e.message)); } }, 'Remover'))));
  }
}
function startEditVehicle(v) {
  editingVehicle = v; $('#v-name').value = v.name; $('#v-plate').value = v.plate || ''; $('#v-driver').value = v.driver || '';
  $('#vtitle').textContent = 'Editar veículo'; $('#btn-vsave').textContent = 'Salvar alterações'; $('#btn-vcancel').hidden = false; $('#v-name').focus();
  $('#vform').scrollIntoView({ block: 'nearest' });
}
function resetVehicleForm() { editingVehicle = null; $('#vform').reset(); $('#vtitle').textContent = 'Novo veículo'; $('#btn-vsave').textContent = 'Cadastrar veículo'; $('#btn-vcancel').hidden = true; }
$('#btn-vcancel').addEventListener('click', resetVehicleForm);
$('#vform').addEventListener('submit', async e => {
  e.preventDefault();
  const body = { name: $('#v-name').value.trim(), plate: $('#v-plate').value.trim(), driver: $('#v-driver').value.trim() };
  if (!body.name) return toast('Informe o nome do veículo.');
  try {
    if (editingVehicle) await api('PATCH', '/api/vehicles/' + editingVehicle.id, body); else await api('POST', '/api/vehicles', body);
    toast(editingVehicle ? 'Veículo atualizado.' : 'Veículo cadastrado. Copie o link do motorista abaixo.');
    resetVehicleForm();
  } catch (err) { toast(err.message); }
});
$('#sform').addEventListener('submit', async e => {
  e.preventDefault();
  const b = $('#btn-settings'); b.disabled = true; b.textContent = 'Localizando…';
  try {
    const addr = $('#s-depot').value.trim() || (depotPt ? 'Depósito' : '');
    const body = { depotAddress: addr, suffix: $('#s-suffix').value.trim() };
    if (depotPt) Object.assign(body, { depotLat: depotPt.lat, depotLng: depotPt.lng, depotLabel: addr });
    await api('PUT', '/api/settings', body);
    depotPt = null; pickDepot = false; gPrev.clearLayers(); $('#btn-depot-pick').textContent = 'Marcar no mapa';
    toast('Depósito salvo.'); fitted = false;
  } catch (err) { toast(err.message); } finally { b.disabled = false; b.textContent = 'Salvar e localizar'; }
});
function renderSettings() {
  if (!settingsInit && gotState) {
    settingsInit = true;
    $('#s-depot').value = S.depot ? S.depot.address : ''; $('#s-suffix').value = (S.settings && S.settings.suffix) || '';
    if (!S.depot) { document.querySelector('#t-veh').click(); }
  }
  $('#s-status').textContent = S.depot ? 'Localizado: ' + S.depot.label : 'Depósito ainda não definido. Informe o endereço e salve.';
}

let pickDepot = false, depotPt = null;
$('#btn-depot-pick').addEventListener('click', () => {
  pickDepot = !pickDepot;
  $('#btn-depot-pick').textContent = pickDepot ? 'Clique no mapa…' : (depotPt ? 'Mudar ponto' : 'Marcar no mapa');
  if (pickDepot) toast('Clique no mapa, no local do depósito. Use o zoom para ficar preciso.');
});
map.on('click', e => {
  if (pickClientId) {
    const id = pickClientId; pickClientId = null;
    api('PATCH', '/api/clients/' + id, { lat: Math.round(e.latlng.lat * 1e6) / 1e6, lng: Math.round(e.latlng.lng * 1e6) / 1e6 }).then(() => toast('Ponto salvo no cadastro do cliente.')).catch(x => toast(x.message));
    return;
  }
  if (!pickDepot) return;
  pickDepot = false; depotPt = { lat: Math.round(e.latlng.lat * 1e6) / 1e6, lng: Math.round(e.latlng.lng * 1e6) / 1e6 };
  gPrev.clearLayers(); L.marker([depotPt.lat, depotPt.lng], { icon: pinIcon('D', '#12202b', 'deposito') }).addTo(gPrev);
  $('#btn-depot-pick').textContent = 'Mudar ponto';
  toast('Ponto marcado. Aperte "Salvar e localizar" para confirmar.');
});

/* ---------------- importação de clientes ---------------- */
let sheet = null, importTotal = 0, pickClientId = null;
const RX = {
  code: /(c[oó]d|\bid\b|matr[ií]cula)/i, client: /(cliente|nome|raz[aã]o|fantasia|destinat)/i, street: /(endere[cç]o|logradouro|\brua\b)/i,
  bairro: /bairro/i, cep: /\bcep\b/i, city: /(cidade|munic)/i, uf: /^(uf|estado)$/i, notes: /(obs|observa)/i
};
$('#f-file').addEventListener('change', async e => {
  const f = e.target.files[0]; if (!f) return;
  if (typeof XLSX === 'undefined') return toast('A biblioteca de planilhas não carregou. Verifique a internet e recarregue a página.');
  try {
    const wb = XLSX.read(await f.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    let aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false, blankrows: false });
    aoa = aoa.map(r => r.map(c => String(c).trim())).filter(r => r.some(c => c));
    if (aoa.length < 2) throw new Error('A planilha precisa ter uma linha de títulos e ao menos uma linha de dados.');
    const width = Math.max(...aoa.map(r => r.length));
    const cols = []; for (let i = 0; i < width; i++) if (aoa.some(r => r[i])) cols.push(i);
    sheet = { headers: Array.from({ length: width }, (_, i) => aoa[0][i] || 'Coluna ' + (i + 1) + ' (sem título)'), cols, rows: aoa.slice(1) };
    buildMapping();
  } catch (err) { sheet = null; $('#mapping').hidden = true; toast(err.message || 'Não consegui ler este arquivo.'); }
});
function buildMapping() {
  const opts = blank => [blank ? h('option', { value: '' }, '(nenhuma)') : null, ...sheet.cols.map(i => h('option', { value: i }, sheet.headers[i]))];
  const find = (rx, skip = []) => { const i = sheet.cols.find(k => !skip.includes(k) && rx.test(sheet.headers[k])); return i === undefined ? '' : String(i); };
  const code = find(RX.code), skipCode = code === '' ? [] : [+code], client = find(RX.client, skipCode);
  const set = (id, blank, val) => { $(id).replaceChildren(...opts(blank)); $(id).value = val; $(id).onchange = updatePreview; };
  set('#m-code', true, code); set('#m-client', false, client || String(sheet.cols[0]));
  set('#m-street', false, find(RX.street, skipCode) || String(sheet.cols[Math.min(1, sheet.cols.length - 1)]));
  set('#m-bairro', true, find(RX.bairro)); set('#m-cep', true, find(RX.cep)); set('#m-city', true, find(RX.city)); set('#m-uf', true, find(RX.uf)); set('#m-notes', true, find(RX.notes));
  $('#mapping').hidden = false; updatePreview();
}
function composeRows() {
  const v = (r, id) => ($(id).value === '' ? '' : (r[+$(id).value] || ''));
  return sheet.rows.map(r => ({ code: v(r, '#m-code'), client: v(r, '#m-client'), street: v(r, '#m-street'), bairro: v(r, '#m-bairro'), cep: v(r, '#m-cep'), city: v(r, '#m-city'), uf: v(r, '#m-uf'), notes: v(r, '#m-notes') }));
}
function updatePreview() {
  const rows = composeRows(), tb = $('#m-preview'); tb.replaceChildren();
  let usable = 0, noNum = 0, cepFull = 0, cepPart = 0, cepNone = 0; const skipped = [], shown = [];
  rows.forEach(r => {
    const sp = Clean.cleanStreet(r.street), cep = Clean.cleanCep(r.cep);
    if (!sp.street && cep.length !== 8) { skipped.push(Clean.cleanName(r.client) || '(sem nome)'); return; }
    usable++; if (!sp.number) noNum++;
    if (cep.length === 8) cepFull++; else if (cep) cepPart++; else cepNone++;
    if (shown.length < 4) shown.push([(r.code ? r.code + ' · ' : '') + (Clean.cleanName(r.client) || '(sem nome)'), Clean.fmtAddress({ street: sp.street, number: sp.number, bairro: Clean.titleCase(r.bairro), cep, uf: r.uf.toUpperCase() || Clean.ufFromCep(cep), city: Clean.titleCase(r.city) })]);
  });
  shown.forEach(s => tb.append(h('tr', {}, h('td', {}, s[0]), h('td', {}, s[1]))));
  const hasCity = $('#m-city').value !== '';
  const lines = [usable + ' clientes serão importados' + (skipped.length ? '. ' + skipped.length + ' sem endereço e sem CEP serão ignorados (' + skipped.slice(0, 4).join(', ') + (skipped.length > 4 ? '…' : '') + ').' : '.')];
  lines.push('CEP completo: ' + cepFull + ' · CEP incompleto: ' + cepPart + ' · sem CEP: ' + cepNone + '.');
  if (cepPart) lines.push('Com CEP incompleto, o estado é deduzido pelo CEP e a cidade é procurada pelo nome da rua e do bairro.');
  if (noNum) lines.push(noNum + ' sem número: ficam com a posição aproximada da rua.');
  if (cepNone && !hasCity) lines.push('Atenção: ' + cepNone + ' sem CEP e a planilha não tem cidade. Para esses, o sistema usa a cidade padrão da aba Frota.');
  $('#m-hint').replaceChildren(...lines.flatMap((t, i) => (i ? [h('br'), t] : [t])));
  $('#btn-import').disabled = !usable;
}
$('#btn-import').addEventListener('click', async () => {
  const rows = composeRows().filter(r => r.street || r.cep);
  if (!rows.length) return;
  const b = $('#btn-import'); b.disabled = true; b.textContent = 'Enviando…';
  try {
    const r = await api('POST', '/api/clients/import', { rows, alsoDeliver: $('#m-also').checked });
    importTotal = r.created + r.updated;
    toast(r.created + ' clientes novos, ' + r.updated + ' atualizados' + (r.delivered ? ', ' + r.delivered + ' incluídos nas entregas de hoje' : '') + '. Localizando os endereços…' + (r.truncated ? ' (limite de 20.000 linhas)' : ''));
    $('#mapping').hidden = true; $('#f-file').value = ''; sheet = null; $('#m-also').checked = false;
  } catch (e) { toast(e.message); } finally { b.disabled = false; b.textContent = 'Importar clientes'; }
});
$('#btn-reg-clear').addEventListener('click', async () => {
  if (!confirm('Apagar todo o cadastro de clientes? As entregas já criadas continuam.')) return;
  try { await api('POST', '/api/clients/clear'); importTotal = 0; toast('Cadastro de clientes apagado.'); } catch (e) { toast(e.message); }
});
function renderRegistry() {
  $('#reg-count').textContent = S.clientCount ? S.clientCount + ' clientes cadastrados' + (S.clientFailed ? ', ' + S.clientFailed + ' sem localização no mapa.' : '.') : 'Nenhum cliente cadastrado ainda.';
  $('#client-hint').textContent = S.clientCount ? S.clientCount + ' clientes cadastrados. Digite o código ou o nome para buscar.' : 'Importe seus clientes na aba Clientes para ter sugestões ao digitar.';
}
function renderGeoProgress() {
  const card = $('#geoprog');
  if (!importTotal) { card.hidden = true; return; }
  card.hidden = false;
  const pend = S.geoPending, failed = S.clientFailed || 0;
  $('#geobar').style.width = Math.min(100, Math.round(Math.max(0, importTotal - pend) / importTotal * 100)) + '%';
  if (pend > 0) {
    $('#geotitle').textContent = 'Localizando endereços';
    $('#geonote').textContent = pend + ' restantes, cerca de ' + Math.max(1, Math.round(pend * 2.5 / 60)) + ' min. Você pode continuar usando o painel.';
  } else {
    $('#geotitle').textContent = 'Endereços localizados';
    $('#geonote').textContent = failed ? failed + ' clientes não foram encontrados no mapa. Corrija-os na lista abaixo.' : 'Tudo localizado.';
  }
}

/* ---------------- clientes não localizados ---------------- */
let failSig = null, failTimer = null;
async function loadFailed() {
  try { renderFailed(await api('GET', '/api/clients/failed')); } catch (e) { /* tenta no próximo evento */ }
}
function renderFailed(data) {
  const card = $('#failcard'), box = $('#faillist');
  const open = new Set([...box.querySelectorAll('details[open]')].map(d => d.dataset.id));
  if (!data.total) { card.hidden = true; box.replaceChildren(); return; }
  card.hidden = false; $('#failtitle').textContent = data.total + ' clientes não localizados';
  box.replaceChildren(...data.clients.map(c => {
    const st = h('input', { value: c.street, maxlength: 200, 'aria-label': 'Rua e número' }), bo = h('input', { value: c.bairro, maxlength: 80, 'aria-label': 'Bairro' }), ce = h('input', { value: c.cep, maxlength: 9, inputmode: 'numeric', 'aria-label': 'CEP' });
    const det = h('details', { 'data-id': c.id, open: open.has(c.id) }, h('summary', { class: 'hint' }, 'Corrigir endereço'),
      h('div', { class: 'form', style: 'padding:8px 0 0' }, h('div', { class: 'field' }, h('label', {}, 'Rua e número'), st), h('div', { class: 'two' }, h('div', { class: 'field' }, h('label', {}, 'Bairro'), bo), h('div', { class: 'field' }, h('label', {}, 'CEP'), ce)),
        h('button', { class: 'btn small primary', type: 'button', onclick: async () => { try { await api('PATCH', '/api/clients/' + c.id, { street: st.value, bairro: bo.value, cep: ce.value }); toast('Buscando de novo…'); } catch (e) { toast(e.message); } } }, 'Salvar e buscar de novo')));
    return h('div', { class: 'vcard', style: '--c:var(--warn)' },
      h('div', {}, h('div', { class: 'who' }, c.code ? h('span', { class: 'code' }, c.code) : null, c.name), h('div', { class: 'addr' }, c.address), h('div', { class: 'chips' }, h('span', { class: 'chip warn' }, c.error || 'Não encontrado'))),
      h('div', { class: 'inline' },
        h('button', { class: 'btn small', type: 'button', onclick: () => { pickClientId = c.id; toast('Clique no mapa, no local do cliente. Use o zoom para ficar preciso.'); } }, 'Marcar no mapa'),
        h('button', { class: 'btn small', type: 'button', onclick: () => api('PATCH', '/api/clients/' + c.id, { retry: true }).then(() => toast('Buscando de novo…')).catch(e => toast(e.message)) }, 'Tentar de novo')),
      det);
  }));
}
function checkFailed() { if (S.clientFailed !== failSig) { failSig = S.clientFailed; clearTimeout(failTimer); failTimer = setTimeout(loadFailed, 600); } }

/* ---------------- sugestões de clientes ---------------- */
let pickedClient = null, suggItems = [], suggIdx = -1, suggTimer = null, suggSeq = 0;
const clientInput = $('#f-client'), suggBox = $('#sugg');
function closeSugg() { suggBox.hidden = true; clientInput.setAttribute('aria-expanded', 'false'); clientInput.removeAttribute('aria-activedescendant'); suggIdx = -1; }
function setActiveSugg(i) {
  suggIdx = i;
  [...suggBox.querySelectorAll('.opt')].forEach((o, k) => { o.setAttribute('aria-selected', String(k === i)); o.classList.toggle('active', k === i); if (k === i) { o.scrollIntoView({ block: 'nearest' }); clientInput.setAttribute('aria-activedescendant', o.id); } });
}
function renderSugg(items, q) {
  suggItems = items; suggBox.replaceChildren();
  if (!items.length) suggBox.append(h('div', { class: 'sugg-empty' }, 'Nenhum cliente cadastrado com "' + q + '". Você pode seguir digitando o nome e o endereço.'));
  items.forEach((c, i) => suggBox.append(h('div', { class: 'opt', role: 'option', id: 'sg' + i, 'aria-selected': 'false', onmousedown: e => { e.preventDefault(); pickClient(c); } },
    h('div', { class: 'opt-t' }, c.code ? h('span', { class: 'code' }, c.code) : null, c.name),
    h('div', { class: 'opt-a' }, c.address),
    (c.inRoute || c.geoStatus !== 'ok') ? h('div', { class: 'chips' },
      c.inRoute ? h('span', { class: 'chip warn' }, 'Já na rota de hoje') : null,
      c.geoStatus === 'falhou' ? h('span', { class: 'chip warn' }, 'Endereço não localizado') : null,
      c.geoStatus === 'pendente' ? h('span', { class: 'chip' }, 'Localizando…') : null) : null)));
  suggBox.hidden = false; clientInput.setAttribute('aria-expanded', 'true');
  setActiveSugg(items.length ? 0 : -1);
}
function pickClient(c) {
  pickedClient = c; clientInput.value = c.name; $('#f-addr').value = c.address;
  if (c.notes && !$('#f-notes').value) $('#f-notes').value = c.notes;
  closeSugg(); $('#results').replaceChildren(); chosen = null; gPrev.clearLayers();
  if (c.geoStatus === 'ok') selectResult({ lat: c.lat, lng: c.lng, label: c.label || c.address, approx: c.approx }, null);
  else { const pv = $('#preview'); pv.hidden = false; pv.textContent = c.geoStatus === 'pendente' ? 'O endereço deste cliente ainda está sendo localizado. Você pode adicionar a entrega mesmo assim.' : 'O endereço deste cliente não foi localizado. Corrija o endereço e use Buscar.'; }
  $('#btn-add').focus();
}
clientInput.addEventListener('input', () => {
  pickedClient = null; clearTimeout(suggTimer);
  const q = clientInput.value.trim();
  if (!q || !S.clientCount) { closeSugg(); return; }
  suggTimer = setTimeout(async () => {
    const seq = ++suggSeq;
    try { const r = await api('GET', '/api/clients/search?q=' + encodeURIComponent(q)); if (seq === suggSeq && document.activeElement === clientInput) renderSugg(r.results, q); } catch (e) { /* sem sugestões */ }
  }, 150);
});
clientInput.addEventListener('keydown', e => {
  if (suggBox.hidden) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); if (suggItems.length) setActiveSugg((suggIdx + 1) % suggItems.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (suggItems.length) setActiveSugg((suggIdx - 1 + suggItems.length) % suggItems.length); }
  else if (e.key === 'Enter' && suggIdx >= 0) { e.preventDefault(); pickClient(suggItems[suggIdx]); }
  else if (e.key === 'Escape') { closeSugg(); }
});
clientInput.addEventListener('blur', () => setTimeout(closeSugg, 150));

/* ---------------- abas, atualização e conexão ---------------- */
const TABS = [['t-del', 'p-del'], ['t-imp', 'p-imp'], ['t-veh', 'p-veh']];
TABS.forEach(([t, p]) => $('#' + t).addEventListener('click', () => TABS.forEach(([t2, p2]) => { $('#' + t2).setAttribute('aria-selected', String(t2 === t)); $('#' + p2).hidden = p2 !== p; })));
function render() { renderKpis(); renderSummary(); renderMap(); renderList(); renderFleet(); renderSettings(); renderRegistry(); renderGeoProgress(); checkFailed(); }
function setConn(s, t) { $('#conn').dataset.s = s; $('#connt').textContent = t; }
const es = new EventSource('/api/events');
es.addEventListener('state', e => {
  S = JSON.parse(e.data); gotState = true;
  const w = $('#storewarn'); w.textContent = S.storageWarning || ''; w.hidden = !S.storageWarning;
  render();
});
es.addEventListener('routes', () => loadRoutes());
es.onopen = () => setConn('live', 'Ao vivo');
es.onerror = () => setConn('err', 'Reconectando…');
loadRoutes();
setInterval(() => { if (gotState) { updateVehicleMarkers(); renderFleet(); } }, 30000);
