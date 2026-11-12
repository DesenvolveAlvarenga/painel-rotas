'use strict';
/* Teste de ponta a ponta com serviços de mapa simulados (não usa a internet). */
const http = require('http'), fs = require('fs'), os = require('os'), path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const hav = (a, b) => { const r = Math.PI / 180, dLat = (b[0] - a[0]) * r, dLng = (b[1] - a[1]) * r; const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLng / 2) ** 2; return 2 * 6371000 * Math.asin(Math.sqrt(s)); };
function hash(s) { let x = 7; for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0; return x; }

const CEPS = {
  '13346250': { city: 'Indaiatuba', state: 'SP', street: 'Rua Antonio Martiliano de Campos', neighborhood: 'Jardim Alice', location: { coordinates: { latitude: '-23.1', longitude: '-47.2' } } },
  '79953076': { city: 'Itaquiraí', state: 'MS', street: 'Rua Nelson Touro Cavaleiro', neighborhood: 'Residencial Cidade Jardim' },
  '86430000': { city: 'Ibaiti', state: 'PR', street: '', neighborhood: '', location: { coordinates: { latitude: '-23.85', longitude: '-50.19' } } }
};
const fake = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  res.setHeader('Content-Type', 'application/json');
  fake.qlog = fake.qlog || []; fake.glog = fake.glog || [];
  let mc;
  if ((mc = u.pathname.match(/^\/cep\/(\d+)$/))) { fake.cepCalls = (fake.cepCalls || 0) + 1; const c = CEPS[mc[1]]; if (!c) { res.statusCode = 404; return res.end('{}'); } return res.end(JSON.stringify(c)); }
  if (/^\/viacep\//.test(u.pathname)) return res.end('{"erro":"true"}');
  if (u.pathname === '/google') {
    const address = u.searchParams.get('address'), comp = u.searchParams.get('components'); fake.glog.push({ address, comp, key: u.searchParams.get('key') });
    if (/Negada/i.test(address)) return res.end(JSON.stringify({ status: 'REQUEST_DENIED', error_message: 'chave' }));
    if (/Zero/i.test(address)) return res.end(JSON.stringify({ status: 'ZERO_RESULTS', results: [] }));
    return res.end(JSON.stringify({ status: 'OK', results: [{ formatted_address: address + ' (google)', geometry: { location: { lat: -23.2, lng: -47.3 }, location_type: /Aprox/i.test(address) ? 'GEOMETRIC_CENTER' : 'ROOFTOP' }, address_components: [{ long_name: 'Indaiatuba', short_name: 'Indaiatuba', types: ['locality'] }, { long_name: 'São Paulo', short_name: 'SP', types: ['administrative_area_level_1'] }] }] }));
  }
  if (u.pathname === '/search') {
    const q = u.searchParams.get('q'); fake.geoCalls = (fake.geoCalls || 0) + 1;
    fake.qlog.push(q === null ? JSON.stringify(Object.fromEntries(u.searchParams)) : q);
    const all = fake.qlog[fake.qlog.length - 1];
    if (/Instavel/i.test(all) && (fake.instavel = (fake.instavel || 0) + 1) <= 4) { res.statusCode = 503; return res.end('[]'); }
    if (/Sempre Fora/i.test(all)) { fake.foraCalls = (fake.foraCalls || 0) + 1; res.statusCode = 503; return res.end('[]'); }
    if (q && /Teste Estado/i.test(q)) return res.end(JSON.stringify([
      { display_name: 'Rua Teste Estado, 10, SP', lat: '-23.0', lon: '-46.0', address: { state: 'São Paulo', postcode: '12345-000' } },
      { display_name: 'Rua Teste Estado, 10, MS', lat: '-20.0', lon: '-54.0', address: { state: 'Mato Grosso do Sul', postcode: '79953-100' } }]));
    if (q === null) { // busca estruturada
      fake.lastStruct = Object.fromEntries(u.searchParams);
      const street = u.searchParams.get('street') || '';
      if (!/Estranha/i.test(street)) return res.end('[]');
      return res.end(JSON.stringify([{ display_name: street + ', ' + u.searchParams.get('city') + ', ' + (u.searchParams.get('state') || '') + ' (estruturado)', lat: '-19.93', lon: '-44.05' }]));
    }
    if (/Estranha/i.test(q)) return res.end('[]');
    if (/inexistente/i.test(q) || /Fantasma, \d+/i.test(q)) return res.end('[]');
    const x = hash(q);
    return res.end(JSON.stringify([{ display_name: q + ' (simulado)', lat: String(-19.9 + (x % 1000) / 10000), lon: String(-44.0 + ((x >> 8) % 1000) / 10000) }]));
  }
  const m = u.pathname.match(/^\/route\/v1\/driving\/(.+)$/);
  if (m) {
    const pts = m[1].split(';').map(p => p.split(',').map(Number)); // lng,lat
    const legs = []; for (let i = 1; i < pts.length; i++) { const d = hav([pts[i - 1][1], pts[i - 1][0]], [pts[i][1], pts[i][0]]) * 1.2; legs.push({ distance: d, duration: d / 8 }); }
    return res.end(JSON.stringify({ code: 'Ok', routes: [{ distance: legs.reduce((s, l) => s + l.distance, 0), duration: legs.reduce((s, l) => s + l.duration, 0), geometry: { type: 'LineString', coordinates: pts }, legs }] }));
  }
  res.statusCode = 404; res.end('{}');
});

const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await new Promise(r => fake.listen(0, r));
  const fport = fake.address().port, dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotas-'));
  const port = 3900 + Math.floor(Math.random() * 90), base = 'http://localhost:' + port;
  const srv = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: port, DATA_DIR: dir, ADMIN_PASSWORD: 'segredo', GEO_GAP_MS: '0', GEO_RETRY_MS: '0', GEO_REQUEUE_MS: '200', NOMINATIM_URL: 'http://localhost:' + fport, OSRM_URL: 'http://localhost:' + fport, CEP_URL: 'http://localhost:' + fport + '/cep', VIACEP_URL: 'http://localhost:' + fport + '/viacep' }, stdio: ['ignore', 'inherit', 'inherit']
  });
  const auth = { Authorization: 'Basic ' + Buffer.from('admin:segredo').toString('base64') };
  const call = async (method, p, body, headers = auth) => {
    const r = await fetch(base + p, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { status: r.status, body: j };
  };
  const ok = (name) => console.log('  ok  ' + name);
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(base + '/healthz'); break; } catch (e) { await wait(100); } }

    assert.strictEqual((await call('GET', '/api/state', null, {})).status, 401); ok('painel exige senha');
    assert.strictEqual((await call('GET', '/api/state', null, { Authorization: 'Basic ' + Buffer.from('x:errada').toString('base64') })).status, 401); ok('senha errada é recusada');
    assert.strictEqual((await call('GET', '/api/state')).status, 200); ok('senha certa entra');
    const trav = await fetch(base + '/..%2fserver.js', { headers: auth }); assert.notStrictEqual(trav.status, 200); ok('bloqueia acesso fora da pasta pública');
    const hdr = await fetch(base + '/', { headers: auth }); assert.notStrictEqual(hdr.headers.get('referrer-policy'), 'no-referrer'); ok('envia o referenciador exigido pelos mapas do OpenStreetMap');
    const idx = await call('GET', '/'); assert.strictEqual(idx.status, 200); assert.match(idx.body, /Painel de Rotas/); ok('serve a página inicial');

    let r = await call('PUT', '/api/settings', { depotAddress: 'Av. Central, 100, Centro', suffix: 'Contagem - MG' });
    assert.strictEqual(r.status, 200); assert.ok(r.body.depot && Math.abs(r.body.depot.lat + 19.9) < 0.2); ok('depósito localizado');

    r = await call('POST', '/api/vehicles', { name: 'Van 1', plate: 'abc1d23', driver: 'Carlos' });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.plate, 'ABC1D23'); const v1 = r.body;
    r = await call('POST', '/api/vehicles', { name: 'Van 2', plate: 'HJK4B56', driver: 'Marina' }); const v2 = r.body;
    assert.strictEqual((await call('POST', '/api/vehicles', { name: '' })).status, 400); ok('cadastro de veículos (e valida nome vazio)');
    r = await call('PATCH', '/api/vehicles/' + v2.id, { driver: 'Marina Souza' }); assert.strictEqual(r.body.driver, 'Marina Souza'); ok('edição de veículo');

    r = await call('GET', '/api/geocode?q=' + encodeURIComponent('Rua das Flores, 240, Centro'));
    assert.strictEqual(r.status, 200); assert.ok(r.body.results.length === 1 && /Contagem, MG/.test(r.body.results[0].label)); ok('busca de endereço (usa cidade padrão)');
    r = await call('GET', '/api/geocode?q=' + encodeURIComponent('Rua Fantasma, 55, Centro'));
    assert.ok(r.body.results.length === 1 && r.body.results[0].approx === true); ok('busca cai para a rua quando o número não existe');
    r = await call('GET', '/api/geocode?q=' + encodeURIComponent('Rua Estranha 10, Bairro Novo'));
    assert.ok(r.body.results.length === 1 && /estruturado/.test(r.body.results[0].label) && r.body.results[0].approx === false);
    assert.strictEqual(fake.lastStruct.state, 'Minas Gerais'); assert.strictEqual(fake.lastStruct.city, 'Contagem'); assert.strictEqual(fake.lastStruct.street, '10 Rua Estranha'); ok('busca acha endereço sem vírgula antes do número usando cidade e estado');
    r = await call('PUT', '/api/settings', { depotAddress: 'Depósito marcado', depotLat: -19.9, depotLng: -44.0, depotLabel: 'Depósito marcado' });
    assert.strictEqual(r.status, 200); assert.strictEqual(r.body.depot.lat, -19.9); ok('depósito definido pelo ponto marcado no mapa');
    assert.strictEqual((await call('GET', '/api/geocode?q=ab')).status, 400); ok('busca curta é recusada');

    const dep = (await call('GET', '/api/state')).body.depot;
    r = await call('GET', '/api/route?from=' + dep.lat + ',' + dep.lng + '&to=-19.85,-43.95');
    assert.strictEqual(r.status, 200); assert.ok(r.body.distanceM > 1000 && r.body.geometry.length >= 2); ok('rota de prévia pelas ruas');

    r = await call('POST', '/api/deliveries', { client: 'Farmácia Vida', address: 'Av. Brasil, 845', priority: 'alta', lat: -19.88, lng: -43.99, label: 'Av. Brasil' });
    assert.strictEqual(r.body.geoStatus, 'ok'); ok('entrega com ponto escolhido na busca');
    r = await call('POST', '/api/deliveries', { client: 'Padaria', address: 'Rua das Acácias, 12, Bairro Novo' });
    assert.strictEqual(r.status, 201); ok('entrega só com endereço digitado');
    assert.strictEqual((await call('POST', '/api/deliveries', { client: 'x', address: '' })).status, 400); ok('endereço vazio é recusado');

    const rows = [];
    for (let i = 1; i <= 10; i++) rows.push({ client: 'Cliente ' + i, address: 'Rua Teste ' + i + ', ' + (100 + i) + ', Bairro ' + (i % 4), priority: i % 5 === 0 ? 'alta' : 'normal', notes: 'obs ' + i });
    rows.push({ client: 'Sem local', address: 'Rua Inexistente 999' }, { client: 'Aprox', address: 'Rua Fantasma, 77, Centro' }, { client: 'Vazio', address: '' });
    r = await call('POST', '/api/deliveries/import', { rows });
    assert.deepStrictEqual([r.body.created, r.body.skipped], [12, 1]); ok('importação de 13 linhas (1 ignorada por falta de endereço)');
    for (let i = 0; i < 50; i++) { if ((await call('GET', '/api/state')).body.geoPending === 0) break; await wait(100); }
    let st = (await call('GET', '/api/state')).body;
    assert.strictEqual(st.geoPending, 0);
    assert.strictEqual(st.deliveries.filter(d => d.geoStatus === 'falhou').length, 1);
    assert.strictEqual(st.deliveries.find(d => d.client === 'Aprox').approx, true); ok('localização em segundo plano (1 não encontrado, 1 aproximado)');

    r = await call('PATCH', '/api/deliveries/' + st.deliveries.find(d => d.client === 'Sem local').id, { address: 'Rua Real, 10', lat: -19.87, lng: -43.97, label: 'Rua Real' });
    assert.strictEqual(r.body.geoStatus, 'ok'); ok('correção manual de endereço não localizado');

    r = await call('POST', '/api/optimize');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body)); assert.strictEqual(r.body.vehicles, 2); assert.ok(r.body.stops >= 13);
    st = (await call('GET', '/api/state')).body;
    const planned = st.deliveries.filter(d => d.status === 'pendente' && d.geoStatus === 'ok');
    assert.ok(planned.every(d => d.vehicleId && d.order > 0 && d.etaMin > 0)); 
    const per = [v1.id, v2.id].map(id => planned.filter(d => d.vehicleId === id).length); assert.ok(Math.abs(per[0] - per[1]) <= 1);
    for (const id of [v1.id, v2.id]) { const o = planned.filter(d => d.vehicleId === id).map(d => d.order).sort((a, b) => a - b); assert.deepStrictEqual(o, o.map((_, i) => i + 1)); }
    const routes = (await call('GET', '/api/routes')).body; assert.ok(routes[v1.id].geometry.length > 2 && routes[v2.id].distanceM > 0);
    assert.ok(r.body.optimizedKm <= r.body.baselineKm * 1.05); ok('otimização divide as paradas, numera e calcula rotas (' + per.join('+') + ' paradas, ' + r.body.optimizedKm.toFixed(1) + ' km vs ' + r.body.baselineKm.toFixed(1) + ' km)');
    const alta = planned.filter(d => d.priority === 'alta' && d.vehicleId === v1.id).length + planned.filter(d => d.priority === 'alta' && d.vehicleId === v2.id).length;
    assert.ok(alta >= 3); ok('prioridades altas entram na rota');

    // motorista
    const tok = (await call('GET', '/api/state')).body.vehicles.find(v => v.id === v1.id).token;
    assert.strictEqual((await fetch(base + '/m/' + tok)).status, 200); ok('página do motorista abre sem a senha do painel');
    r = await call('GET', '/api/driver/' + tok, null, {});
    assert.strictEqual(r.status, 200); assert.ok(r.body.stops.length > 0 && !('token' in r.body.vehicle)); ok('motorista vê só as próprias paradas');
    assert.strictEqual((await call('GET', '/api/driver/' + 'a'.repeat(24), null, {})).status, 404); ok('link inválido é recusado');
    assert.strictEqual((await call('POST', '/api/driver/' + tok + '/position', { lat: 999, lng: 0 }, {})).status, 400); ok('posição inválida é recusada');
    assert.strictEqual((await call('POST', '/api/driver/' + tok + '/position', { lat: -19.9, lng: -44.0 }, {})).status, 200);
    st = (await call('GET', '/api/state')).body; const sv = st.vehicles.find(v => v.id === v1.id);
    assert.strictEqual(sv.status, 'em_rota'); assert.strictEqual(sv.lat, -19.9); ok('GPS do motorista atualiza a posição do veículo');
    const first = r.body.stops.filter(s => s.status === 'pendente')[0];
    assert.strictEqual((await call('POST', '/api/driver/' + tok + '/deliver', { id: first.id }, {})).status, 200);
    const other = st.deliveries.find(d => d.vehicleId === v2.id);
    assert.strictEqual((await call('POST', '/api/driver/' + tok + '/deliver', { id: other.id }, {})).status, 404); ok('motorista registra entrega e não mexe em entrega de outro veículo');
    assert.strictEqual((await call('GET', '/api/driver/' + tok, null, {})).body.stops.find(s => s.id === first.id).status, 'entregue');

    // tempo real (SSE)
    const ev = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('SSE sem evento')), 4000); let buf = ''; const ac = new AbortController();
      fetch(base + '/api/events', { headers: auth, signal: ac.signal }).then(async resp => {
        const rd = resp.body.getReader(); const dec = new TextDecoder(); let sawState = 0;
        for (;;) { const { value, done } = await rd.read(); if (done) break; buf += dec.decode(value);
          if ((buf.match(/event: state/g) || []).length >= 1 && !sawState) { sawState = 1; call('POST', '/api/driver/' + tok + '/position', { lat: -19.91, lng: -44.01 }, {}); }
          if ((buf.match(/event: state/g) || []).length >= 2) { clearTimeout(t); ac.abort(); resolve(buf); return; } }
      }).catch(e => { if (e.name !== 'AbortError') reject(e); });
    });
    assert.match(ev, /-19\.91/); ok('painel recebe a posição do veículo em tempo real (SSE)');

    // cadastro de clientes
    const waitGeo = async () => { for (let i = 0; i < 60; i++) { if ((await call('GET', '/api/state')).body.geoPending === 0) return; await wait(100); } };
    r = await call('POST', '/api/clients/import', { rows: [
      { code: '1001', client: 'Mercado São João', address: 'Rua Alfa 10, Centro', notes: 'portão azul' },
      { code: '1002', client: 'Açougue Boi Gordo', address: 'Rua Beta 20, Centro' },
      { code: '2001', client: 'Padaria Pão Quente', address: 'Rua Gama 30, Centro' },
      { code: '', client: 'Sem endereço', address: '' }] });
    assert.deepStrictEqual([r.body.created, r.body.updated, r.body.skipped], [3, 0, 1]); ok('importação de clientes (3 cadastrados, 1 sem endereço ignorado)');
    await waitGeo();
    r = await call('POST', '/api/clients/import', { rows: [{ code: '1001', client: 'Mercado São João Ltda', address: 'Rua Alfa 10, Centro' }] });
    assert.deepStrictEqual([r.body.created, r.body.updated], [0, 1]);
    assert.strictEqual((await call('GET', '/api/state')).body.clientCount, 3); ok('reimportar atualiza pelo código, sem duplicar');
    const sr = async q => (await call('GET', '/api/clients/search?q=' + encodeURIComponent(q))).body.results;
    let hits = await sr('1001'); assert.strictEqual(hits[0].code, '1001'); assert.strictEqual(hits[0].name, 'Mercado São João Ltda'); ok('sugestão por código exato vem primeiro');
    hits = await sr('100'); assert.deepStrictEqual(hits.map(x => x.code).sort(), ['1001', '1002']); ok('sugestão por início do código');
    hits = await sr('acougue'); assert.strictEqual(hits[0].name, 'Açougue Boi Gordo'); ok('sugestão por nome ignora acentos e maiúsculas');
    hits = await sr('quente'); assert.strictEqual(hits[0].code, '2001'); ok('sugestão por palavra do meio do nome');
    assert.strictEqual((await sr('zzzz')).length, 0); ok('sem resultado quando nada combina');
    const cl = (await sr('1002'))[0]; assert.strictEqual(cl.geoStatus, 'ok');
    r = await call('POST', '/api/deliveries', { client: cl.name, address: cl.address, clientId: cl.id, lat: cl.lat, lng: cl.lng, label: cl.label });
    assert.strictEqual(r.status, 201); assert.strictEqual(r.body.clientId, cl.id); assert.strictEqual(r.body.code, '1002'); assert.strictEqual(r.body.geoStatus, 'ok'); ok('entrega criada a partir do cliente sugerido');
    r = await call('POST', '/api/deliveries', { client: cl.name, address: cl.address, clientId: cl.id });
    assert.strictEqual(r.status, 409); ok('mesmo cliente duas vezes no dia é recusado');
    assert.strictEqual((await sr('1002'))[0].inRoute, true); ok('sugestão avisa quando o cliente já está na rota');
    r = await call('POST', '/api/clients/import', { rows: [{ code: '3001', client: 'Loja Delta', address: 'Rua Delta 5, Centro' }], alsoDeliver: true });
    assert.strictEqual(r.body.delivered, 1); await waitGeo();
    st = (await call('GET', '/api/state')).body; const dd = st.deliveries.find(d => d.code === '3001');
    assert.ok(dd && dd.geoStatus === 'ok' && dd.lat != null); ok('importar já incluindo na rota de hoje (localização copiada do cliente)');

    // planilha real: endereço sem cidade, CEP completo ou cortado, nome com número na frente
    r = await call('PUT', '/api/settings', { suffix: 'Contagem - MG' });
    const xrows = [
      { code: '5001', client: '30.201.654 FULANO TESTE (BETO)', street: 'RUA ANTONIO MARTILIANO DE CAMPOS,438', bairro: 'JARDIM ALICE', cep: '13346250' },
      { code: '5002', client: 'BELTRANO COM 05912589943', street: 'AV. PROF. FRANCISCO MORATO, 2203 APT.31', bairro: 'BUTANTAM', cep: '055133' },
      { code: '5003', client: 'CICLANO ESTADO', street: 'RUA TESTE ESTADO, 10', bairro: 'CENTRO', cep: '79953076' },
      { code: '5004', client: 'SEM RUA', street: ' ,', bairro: '', cep: '86430000' },
      { code: '5005', client: 'NAO EXISTE', street: 'RUA INEXISTENTE 5', bairro: 'JARDIM X', cep: '04321100' },
      { code: '285', client: 'CARGA TOTAL - LEO', street: '', bairro: '', cep: '' }];
    fake.qlog.length = 0;
    r = await call('POST', '/api/clients/import', { rows: xrows });
    assert.deepStrictEqual([r.body.created, r.body.skipped], [5, 1]); assert.deepStrictEqual(r.body.skippedNames, ['CARGA TOTAL - LEO']); ok('linha sem endereço nem CEP é ignorada e avisada pelo nome');
    await waitGeo(); await wait(300);
    const get5 = async q => (await sr(q))[0];
    let c1 = await get5('5001');
    assert.strictEqual(c1.name, 'FULANO TESTE (BETO)'); ok('número de cadastro na frente do nome é removido');
    assert.strictEqual((await get5('5002')).name, 'BELTRANO COM'); ok('CPF no fim do nome é removido');
    assert.strictEqual(c1.address, 'Rua Antonio Martiliano de Campos, 438 · Jardim Alice · Indaiatuba/SP'); ok('endereço limpo com cidade e estado vindos do CEP');
    assert.ok(fake.qlog.some(x => x.includes('"street":"438 Rua Antonio Martiliano de Campos"') && x.includes('"city":"Indaiatuba"') && x.includes('"state":"São Paulo"'))); ok('busca usa rua, número, cidade e estado do CEP');
    assert.ok(!fake.qlog.some(x => /Contagem/.test(x) && /Martiliano|Francisco Morato|Teste Estado/.test(x))); ok('cidade padrão não é misturada quando o CEP já diz onde fica');
    assert.ok(fake.qlog.some(x => /Francisco Morato, 2203/.test(x) && /São Paulo/.test(x)) && !fake.qlog.some(x => /APT/i.test(x))); ok('CEP cortado ainda indica o estado; complemento (APT) é descartado');
    const c3 = (await call('GET', '/api/clients/search?q=5003')).body.results[0];
    assert.ok(Math.abs(c3.lat + 20.0) < 0.01); ok('entre dois resultados escolhe o do estado do CEP');
    const c4 = (await call('GET', '/api/clients/search?q=5004')).body.results[0];
    assert.strictEqual(c4.geoStatus, 'ok'); assert.strictEqual(c4.geoSource, 'cep'); assert.strictEqual(c4.approx, true); ok('cliente só com CEP completo usa a posição do CEP, marcada como aproximada');
    const fl = (await call('GET', '/api/clients/failed')).body;
    assert.strictEqual(fl.total, 1); assert.strictEqual(fl.clients[0].code, '5005'); ok('cliente não localizado aparece na lista de falhas');
    r = await call('PATCH', '/api/clients/' + fl.clients[0].id, { lat: -19.95, lng: -44.05 });
    assert.strictEqual(r.status, 200); assert.strictEqual((await call('GET', '/api/clients/failed')).body.total, 0);
    const c5 = (await call('GET', '/api/clients/search?q=5005')).body.results[0]; assert.strictEqual(c5.geoSource, 'manual'); ok('ponto marcado à mão fica salvo no cadastro');
    r = await call('POST', '/api/clients/import', { rows: xrows.slice(0, 5) });
    assert.deepStrictEqual([r.body.created, r.body.updated], [0, 5]); const before = fake.geoCalls; await wait(400); assert.strictEqual(fake.geoCalls, before);
    assert.strictEqual((await get5('5005')).geoSource, 'manual'); ok('reimportar a mesma planilha não refaz buscas nem apaga o ponto marcado');
    fake.cepCalls = 0; r = await call('POST', '/api/clients/import', { rows: [{ code: '5006', client: 'OUTRO', street: 'RUA BETA 20', bairro: 'CENTRO', cep: '13346250' }] }); await waitGeo();
    assert.strictEqual(fake.cepCalls || 0, 0); ok('consulta de CEP repetida vem da memória');
    r = await call('PATCH', '/api/clients/' + c5.id, { street: 'RUA TESTE ESTADO, 12', cep: '79953076' }); await waitGeo(); await wait(300);
    assert.ok(Math.abs((await get5('5005')).lat + 20.0) < 0.01); ok('corrigir o endereço de um cliente busca de novo');

    r = await call('POST', '/api/clients/import', { rows: [
      { code: '7001', client: 'Cliente Instavel', street: 'Rua Instavel 10', city: 'Contagem', uf: 'MG' },
      { code: '7002', client: 'Cliente Fora', street: 'Rua Sempre Fora 20', city: 'Contagem', uf: 'MG' }] });
    for (let i = 0; i < 100 && (await call('GET', '/api/state')).body.geoPending; i++) await wait(100);
    const ci = (await call('GET', '/api/clients/search?q=7001')).body.results[0];
    assert.strictEqual(ci.geoStatus, 'ok'); assert.ok(fake.instavel >= 5); ok('serviço de busca falhando por um tempo: espera, tenta de novo e localiza o cliente');
    const cf = (await call('GET', '/api/clients/failed')).body.clients.find(x => x.code === '7002');
    assert.ok(cf && /indisponível/.test(cf.error)); assert.strictEqual(fake.foraCalls, 9); ok('serviço sempre fora: desiste após 3 rodadas de 3 tentativas e avisa');

    // Google (opcional)
    const gport = port + 100, gdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rotasg-'));
    const gsrv = spawn('node', [path.join(__dirname, '..', 'server.js')], { env: { ...process.env, PORT: gport, DATA_DIR: gdir, GEO_GAP_MS: '0', GOOGLE_MAPS_KEY: 'CHAVE-TESTE', GOOGLE_GEOCODE_URL: 'http://localhost:' + fport + '/google', CEP_URL: 'http://localhost:' + fport + '/cep', VIACEP_URL: 'http://localhost:' + fport + '/viacep' }, stdio: ['ignore', 'ignore', 'inherit'] });
    try {
      const gb = 'http://localhost:' + gport; for (let i = 0; i < 50; i++) { try { await fetch(gb + '/healthz'); break; } catch (e) { await wait(100); } }
      const gcall = (m, p2, b) => fetch(gb + p2, { method: m, headers: { 'Content-Type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }).then(x => x.json());
      await gcall('POST', '/api/clients/import', { rows: [
        { code: '1', client: 'G1', street: 'RUA ANTONIO MARTILIANO DE CAMPOS,438', bairro: 'JARDIM ALICE', cep: '13346250' },
        { code: '2', client: 'G2', street: 'RUA ZERO 5', bairro: 'X', cep: '' },
        { code: '3', client: 'G3', street: 'RUA APROX 9', bairro: 'X', cep: '' }] });
      let gs; for (let i = 0; i < 60; i++) { gs = await gcall('GET', '/api/state'); if (!gs.geoPending) break; await wait(100); }
      const g1 = (await gcall('GET', '/api/clients/search?q=1')).results.find(x => x.code === '1'), g3 = (await gcall('GET', '/api/clients/search?q=3')).results.find(x => x.code === '3');
      assert.strictEqual(g1.geoSource, 'google'); assert.strictEqual(g1.approx, false); assert.strictEqual(g3.approx, true);
      assert.ok(fake.glog.some(x => x.comp === 'country:BR|postal_code:13346-250' && x.key === 'CHAVE-TESTE' && /438/.test(x.address))); ok('com chave do Google: usa o Google, com CEP e número, e marca posição aproximada');
      assert.strictEqual(gs.clientFailed, 1); ok('Google sem resultado vira cliente não localizado');
      await gcall('POST', '/api/clients/import', { rows: [{ code: '4', client: 'G4', street: 'RUA NEGADA 1', bairro: 'X', cep: '' }] }); await wait(500);
      const gf = (await gcall('GET', '/api/clients/failed')).clients.find(x => x.code === '4'); assert.match(gf.error, /Chave do Google recusada/); ok('chave do Google recusada gera mensagem clara');
    } finally { gsrv.kill(); }

    // persistência
    await wait(500); const saved = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
    assert.ok(saved.vehicles.length === 2 && saved.deliveries.length >= 14); ok('dados gravados em disco');

    r = await call('POST', '/api/clear-day'); assert.strictEqual(r.status, 200);
    st = (await call('GET', '/api/state')).body; assert.strictEqual(st.deliveries.length, 0); assert.strictEqual(st.vehicles.length, 2); ok('limpar o dia mantém veículos e depósito');
    console.log('\nTodos os testes passaram.');
    process.exitCode = 0;
  } catch (e) { console.error('\nFALHOU:', e.message); process.exitCode = 1; }
  finally { srv.kill(); fake.close(); }
})();
