'use strict';
/*
 * Onde os dados ficam salvos.
 * - Sem DATABASE_URL: arquivo data.json na pasta DATA_DIR (uso local).
 * - Com DATABASE_URL: uma linha numa tabela do Postgres (Supabase, Neon...), para
 *   hospedagens sem disco persistente, como o plano gratuito do Render.
 * Na primeira vez com banco vazio, o conteúdo do data.json local (se existir) é enviado ao banco.
 */
const fs = require('fs');
const path = require('path');

function fileStore(dataDir) {
  const file = path.join(dataDir, 'data.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
  return {
    kind: 'arquivo ' + file,
    delayMs: 300,
    load: async () => read(),
    save: async text => {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, file);
    },
    saveSync: text => {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file + '.tmp', text);
      fs.renameSync(file + '.tmp', file);
    },
    readLocal: read
  };
}

function pgStore(url, dataDir) {
  let Pool;
  try { ({ Pool } = require('pg')); } catch (e) { throw new Error('DATABASE_URL definida, mas o pacote "pg" não está instalado. Rode: npm install'); }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = process.env.PGSSL === 'disable' || local ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url, ssl, max: 2 });
  pool.on('error', e => console.error('Banco de dados:', e.message));
  const fallback = fileStore(dataDir);
  return {
    kind: 'banco de dados Postgres',
    delayMs: Number(process.env.SAVE_EVERY_MS) || 4000,
    load: async () => {
      await pool.query('create table if not exists painel_estado (id int primary key, dados jsonb not null, atualizado_em timestamptz not null default now())');
      const r = await pool.query('select dados from painel_estado where id = 1');
      if (r.rows.length) return r.rows[0].dados;
      const fromFile = fallback.readLocal();
      if (fromFile) console.log('Banco vazio: enviando os dados do data.json local para o banco.');
      return fromFile;
    },
    save: async text => {
      await pool.query('insert into painel_estado (id, dados, atualizado_em) values (1, $1::jsonb, now()) on conflict (id) do update set dados = excluded.dados, atualizado_em = now()', [text]);
    },
    close: () => pool.end()
  };
}

function createStore(dataDir) {
  const url = process.env.DATABASE_URL;
  return url ? pgStore(url, dataDir) : fileStore(dataDir);
}

module.exports = { createStore };
