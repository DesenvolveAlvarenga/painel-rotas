'use strict';
/* Limpeza dos dados de clientes (usada no servidor e no navegador). */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Clean = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const SMALL = new Set(['de', 'da', 'do', 'das', 'dos', 'e', 'em', 'na', 'no', 'nas', 'nos']);
  const ROMAN = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx|xxi|xxii|xxiii)$/;
  const FIRST = { AV: 'AVENIDA', AVD: 'AVENIDA', R: 'RUA', ROD: 'RODOVIA', ESTR: 'ESTRADA', EST: 'ESTRADA', AL: 'ALAMEDA', TV: 'TRAVESSA', TRAV: 'TRAVESSA', PC: 'PRAÇA', PCA: 'PRAÇA', 'PÇA': 'PRAÇA', LGO: 'LARGO', VLA: 'VILA' };
  const SAFE = { PROF: 'PROFESSOR', PROFA: 'PROFESSORA', DR: 'DOUTOR', DRA: 'DOUTORA', CEL: 'CORONEL', ENG: 'ENGENHEIRO', STA: 'SANTA', STO: 'SANTO', GAL: 'GENERAL', CAP: 'CAPITÃO', DEP: 'DEPUTADO', PREF: 'PREFEITO', PRES: 'PRESIDENTE', PRESID: 'PRESIDENTE', GOV: 'GOVERNADOR', SEN: 'SENADOR', VISC: 'VISCONDE', CONS: 'CONSELHEIRO', MONS: 'MONSENHOR', BRIG: 'BRIGADEIRO', CMTE: 'COMANDANTE', CDOR: 'COMENDADOR' };
  const DOTTED = { MAL: 'MARECHAL', ALM: 'ALMIRANTE', TEN: 'TENENTE', SGT: 'SARGENTO', VER: 'VEREADOR', DES: 'DESEMBARGADOR', PE: 'PADRE', COM: 'COMENDADOR' };
  const UF_NAMES = { AC: 'Acre', AL: 'Alagoas', AP: 'Amapá', AM: 'Amazonas', BA: 'Bahia', CE: 'Ceará', DF: 'Distrito Federal', ES: 'Espírito Santo', GO: 'Goiás', MA: 'Maranhão', MT: 'Mato Grosso', MS: 'Mato Grosso do Sul', MG: 'Minas Gerais', PA: 'Pará', PB: 'Paraíba', PR: 'Paraná', PE: 'Pernambuco', PI: 'Piauí', RJ: 'Rio de Janeiro', RN: 'Rio Grande do Norte', RS: 'Rio Grande do Sul', RO: 'Rondônia', RR: 'Roraima', SC: 'Santa Catarina', SP: 'São Paulo', SE: 'Sergipe', TO: 'Tocantins' };

  function titleCase(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim().split(' ').map((w, i) => {
      if (ROMAN.test(w)) return w.toUpperCase();
      if (i > 0 && SMALL.has(w)) return w;
      return w.replace(/(^|[-'(\/])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    }).join(' ');
  }
  function expand(street) {
    const tokens = street.split(' ');
    return tokens.map((t, i) => {
      const dot = /\.$/.test(t), bare = t.replace(/\.$/, '').toUpperCase();
      if (i === 0 && FIRST[bare]) return FIRST[bare];
      if (SAFE[bare]) return SAFE[bare];
      if (dot && DOTTED[bare]) return DOTTED[bare];
      return t;
    }).join(' ');
  }
  function cleanName(raw) {
    let n = String(raw || '').replace(/\s+/g, ' ').trim();
    n = n.replace(/^\d{1,3}\.\d{3}\.\d{3}[\s-]*/, '');
    n = n.replace(/\s+(\d{11}|\d{14})$/, '');
    return n.replace(/[\s,;-]+$/, '').trim();
  }
  /* "RUA X,438", "AV Y. 513", "R. Z, 2203 APT.31", "AV W/ S/N" -> rua, número e o que sobrou depois do número */
  function cleanStreet(raw) {
    let s = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!/[\p{L}\d]/u.test(s)) return { street: '', number: '', tail: '', km: '' };
    s = s.replace(/([A-Za-zÀ-ÿ])\.(?=[A-Za-zÀ-ÿ])/g, '$1 ');
    s = s.replace(/(^|[\s,.\/-])(?:S\/?N|S\.N\.?|SEM\s+N[ÚU]MERO)[º°]?(?=$|[\s,.\/-])/gi, '$1');
    /* lote/quadra com número não são o número da casa ("AV RIO BRANCO LOTE 13") */
    s = s.replace(/[\s,;-]+(?:LOTE|LT\.?|QD\.?|QUADRA)\s*\d+[A-Za-z]?\b/gi, '');
    s = s.replace(/(\d)[\s,;-]*(?:APT?O?\.?|APARTAMENTO|AP\.?|BLOCO|BL\.?|LOJA|SALA|CJ\.?|CONJ\.?|ANDAR|FUNDOS|CASA|GALP[ÃA]O|GALP\.?|GLP\.?|LOTE|LT\.?|QD\.?|QUADRA|NEXO|ANEXO|T[ÉE]RREO)\b.*$/i, '$1');
    s = s.replace(/(\d)\s*\/.*$/, '$1');
    let number = '', km = '', before = s, tail = '';
    const found = [...s.matchAll(/\d+/g)];
    for (let k = found.length - 1; k >= 0; k--) {
      const m = found[k], b = s.slice(0, m.index), a = s.slice(m.index + m[0].length);
      if (/^\s*(DE|DO|DA|DOS|DAS)\b/i.test(a) || /^\s*[ºª°]/.test(a)) continue;
      if (m[0].length > 6) continue;
      if (/\bKM\s*\.?\s*$/i.test(b)) { km = m[0]; before = b.replace(/[\s,.;-]*\bKM\s*\.?\s*$/i, ''); break; }
      if (/\bROD/i.test(s) && /\b(BR|[A-Z]{2})[\s-]*$/i.test(b)) continue;
      number = String(parseInt(m[0], 10)); before = b; tail = a.replace(/^[\s,.;-]+/, '').trim(); break;
    }
    before = before.replace(/[\s,.;\/-]+(N[º°oO]?|NUM|N[ÚU]MERO)\.?[\s,.;\/-]*$/i, '').replace(/[\s,.;\/-]+$/, '').trim();
    return { street: titleCase(expand(before)), number, tail, km };
  }
  function cleanCep(raw) {
    let d = String(raw == null ? '' : raw).replace(/\D/g, '');
    if (d.length === 7) d = '0' + d;
    if (d.length > 8 || d.length < 5) return '';
    return d;
  }
  function fmtCep(d) { return d && d.length === 8 ? d.slice(0, 5) + '-' + d.slice(5) : (d || ''); }
  const RANGES = [[1000, 19999, 'SP'], [20000, 28999, 'RJ'], [29000, 29999, 'ES'], [30000, 39999, 'MG'], [40000, 48999, 'BA'], [49000, 49999, 'SE'], [50000, 56999, 'PE'], [57000, 57999, 'AL'], [58000, 58999, 'PB'], [59000, 59999, 'RN'], [60000, 63999, 'CE'], [64000, 64999, 'PI'], [65000, 65999, 'MA'], [66000, 68899, 'PA'], [68900, 68999, 'AP'], [69000, 69299, 'AM'], [69300, 69399, 'RR'], [69400, 69899, 'AM'], [69900, 69999, 'AC'], [70000, 72799, 'DF'], [72800, 72999, 'GO'], [73000, 73699, 'DF'], [73700, 76799, 'GO'], [76800, 76999, 'RO'], [77000, 77999, 'TO'], [78000, 78899, 'MT'], [79000, 79999, 'MS'], [80000, 87999, 'PR'], [88000, 89999, 'SC'], [90000, 99999, 'RS']];
  function ufFromCep(d) {
    if (!d || d.length < 5) return '';
    const n = Number(d.slice(0, 5));
    const r = RANGES.find(x => n >= x[0] && n <= x[1]);
    return r ? r[2] : '';
  }
  function fmtAddress(c) {
    const loc = c.city && c.uf ? c.city + '/' + c.uf : (c.uf || c.city || '');
    const st = c.street ? c.street + (c.number ? ', ' + c.number : '') : (c.cep ? 'CEP ' + fmtCep(c.cep) : '');
    return [st, c.bairro, loc].filter(Boolean).join(' · ');
  }
  return { titleCase, cleanName, cleanStreet, cleanCep, fmtCep, ufFromCep, fmtAddress, UF_NAMES };
});
