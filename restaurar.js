'use strict';
/*
 * Restaura os dados do banco a partir de um backup automático ou de um arquivo data.json.
 *   npm run restaurar                       -> lista os backups
 *   npm run restaurar -- 42                 -> restaura o backup número 42
 *   npm run restaurar -- arquivo data/data.json -> envia esse arquivo para o banco
 * Antes de restaurar, o estado atual vira um backup ("antes de restaurar"), então dá para desfazer.
 * Requer a variável DATABASE_URL.
 */
const fs = require('fs');
const { pgPool, ensureTables } = require('./storage.js');

const url = process.env.DATABASE_URL;
if (!url) { console.error('Defina DATABASE_URL antes. PowerShell: $env:DATABASE_URL="postgresql://..."'); process.exit(1); }

const resumo = d => {
  const c = d.clients || [];
  return (c.length + ' clientes (' + c.filter(x => x.geoStatus === 'ok').length + ' localizados), ' +
    (d.vehicles || []).length + ' veículos, ' + (d.deliveries || []).length + ' entregas');
};
const quando = t => new Date(t).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });

(async () => {
  const pool = pgPool(url);
  try {
    await ensureTables(pool);
    const [arg, arg2] = process.argv.slice(2);
    const atual = (await pool.query('select dados from painel_estado where id = 1')).rows[0];

    if (!arg) {
      console.log('Agora no banco: ' + (atual ? resumo(atual.dados) : 'vazio') + '\n');
      const r = await pool.query('select id, criado_em, motivo, dados from painel_backup order by id desc limit 30');
      if (!r.rows.length) console.log('Nenhum backup ainda.');
      for (const b of r.rows) console.log(String(b.id).padStart(5) + '  ' + quando(b.criado_em) + '  ' + b.motivo.padEnd(18) + resumo(b.dados));
      console.log('\nPara restaurar: npm run restaurar -- <número>');
      return;
    }

    let novo, origem;
    if (arg === 'arquivo') {
      if (!arg2) throw new Error('Informe o caminho do arquivo, por exemplo: npm run restaurar -- arquivo data/data.json');
      novo = JSON.parse(fs.readFileSync(arg2, 'utf8')); origem = 'arquivo ' + arg2;
    } else {
      const r = await pool.query('select dados, criado_em from painel_backup where id = $1', [Number(arg)]);
      if (!r.rows.length) throw new Error('Backup ' + arg + ' não encontrado. Rode sem número para ver a lista.');
      novo = r.rows[0].dados; origem = 'backup ' + arg + ' de ' + quando(r.rows[0].criado_em);
    }

    if (atual) await pool.query('insert into painel_backup (motivo, dados) values ($1, $2::jsonb)', ['antes de restaurar', JSON.stringify(atual.dados)]);
    await pool.query('insert into painel_estado (id, dados, versao) values (1, $1::jsonb, 1) on conflict (id) do update set dados = excluded.dados, versao = painel_estado.versao + 1, atualizado_em = now()', [JSON.stringify(novo)]);
    console.log('Restaurado de ' + origem + ': ' + resumo(novo));
    console.log('Reinicie o app na hospedagem (no Render: Manual Deploy → Restart) para ele carregar os dados restaurados.');
  } catch (e) {
    console.error('Erro: ' + e.message); process.exitCode = 1;
  } finally { await pool.end(); }
})();
