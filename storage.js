'use strict';
/*
 * Onde os dados ficam salvos.
 * - Sem DATABASE_URL: arquivo data.json na pasta DATA_DIR (uso local).
 * - Com DATABASE_URL: uma linha numa tabela do Postgres (Supabase, Neon...), para
 *   hospedagens sem disco persistente, como o plano gratuito do Render.
 * Na primeira vez com banco vazio, o conteúdo do data.json local (se existir) é enviado ao banco.
 *
 * Proteções no banco:
 * - Versão: cada gravação só vale se o banco ainda estiver na versão que este processo leu.
 *   Se outra cópia do app gravou antes (deploy em andamento, app aberto no computador e na nuvem),
 *   a gravação é recusada com err.code = 'CONFLITO' e o servidor recarrega do banco, em vez de
 *   apagar o que a outra cópia salvou.
 * - Backups: uma cópia ao iniciar e outra a cada BACKUP_EVERY_MIN minutos (padrão 30), guardando
 *   as BACKUP_KEEP mais recentes (padrão 100). Para restaurar: npm run restaurar
 */
const fs = require('fs');
const path = require('path');

const CLOUD = !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.VERCEL);

function fileStore(dataDir) {
  const file = path.join(dataDir, 'data.json');
  const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; } };
  const write = text => {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file + '.tmp', text);
    fs.renameSync(file + '.tmp', file);
  };
  return {
    kind: 'arquivo ' + file,
    /* Na nuvem sem DATA_DIR apontando para um disco, o arquivo some a cada reinício. */
    temporary: CLOUD && !process.env.DATA_DIR,
    delayMs: 300,
    load: async () => read(),
    save: async text => write(text),
    saveSync: write,
    readLocal: read
  };
}

function pgPool(url) {
  let Pool;
  try { ({ Pool } = require('pg')); } catch (e) { throw new Error('DATABASE_URL definida, mas o pacote "pg" não está instalado. Rode: npm install'); }
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const ssl = process.env.PGSSL === 'disable' || local ? false : { rejectUnauthorized: false };
  const pool = new Pool({ connectionString: url, ssl, max: 2 });
  pool.on('error', e => console.error('Banco de dados:', e.message));
  return pool;
}

async function ensureTables(pool) {
  await pool.query('create table if not exists painel_estado (id int primary key, dados jsonb not null, atualizado_em timestamptz not null default now())');
  await pool.query('alter table painel_estado add column if not exists versao bigint not null default 0');
  await pool.query('create table if not exists painel_backup (id bigserial primary key, criado_em timestamptz not null default now(), motivo text not null, dados jsonb not null)');
}

function pgStore(url, dataDir) {
  const pool = pgPool(url);
  const fallback = fileStore(dataDir);
  const BACKUP_MS = (Number(process.env.BACKUP_EVERY_MIN) || 30) * 60000;
  const KEEP = Number(process.env.BACKUP_KEEP) || 100;
  let version = null, lastBackup = 0;

  async function backup(text, motivo) {
    lastBackup = Date.now();
    try {
      await pool.query('insert into painel_backup (motivo, dados) values ($1, $2::jsonb)', [motivo, text]);
      await pool.query('delete from painel_backup where id not in (select id from painel_backup order by id desc limit $1)', [KEEP]);
    } catch (e) { console.error('Falha ao criar backup:', e.message); }
  }
  async function read() {
    const r = await pool.query('select dados, versao from painel_estado where id = 1');
    if (!r.rows.length) { version = null; return null; }
    version = Number(r.rows[0].versao);
    return r.rows[0].dados;
  }

  return {
    kind: 'banco de dados Postgres',
    temporary: false,
    delayMs: Number(process.env.SAVE_EVERY_MS) || 4000,
    load: async () => {
      await ensureTables(pool);
      const saved = await read();
      if (saved) { await backup(JSON.stringify(saved), 'ao iniciar'); return saved; }
      const fromFile = fallback.readLocal();
      if (fromFile) console.log('Banco vazio: enviando os dados do data.json local para o banco.');
      return fromFile;
    },
    reload: read,
    save: async text => {
      let r;
      if (version === null) r = await pool.query('insert into painel_estado (id, dados, versao) values (1, $1::jsonb, 1) on conflict (id) do nothing', [text]);
      else r = await pool.query('update painel_estado set dados = $1::jsonb, versao = versao + 1, atualizado_em = now() where id = 1 and versao = $2', [text, version]);
      if (r.rowCount !== 1) { const e = new Error('outra cópia do app gravou no banco'); e.code = 'CONFLITO'; throw e; }
      version = version === null ? 1 : version + 1;
      if (Date.now() - lastBackup >= BACKUP_MS) await backup(text, 'automático');
    },
    close: () => pool.end()
  };
}

function createStore(dataDir) {
  const url = process.env.DATABASE_URL;
  return url ? pgStore(url, dataDir) : fileStore(dataDir);
}

module.exports = { createStore, pgPool, ensureTables };
