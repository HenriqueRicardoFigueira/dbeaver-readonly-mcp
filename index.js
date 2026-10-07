import { readFileSync } from 'node:fs';
import { createDecipheriv } from 'node:crypto';
import { homedir, platform } from 'node:os';
import { checkServerIdentity } from 'node:tls';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const DBEAVER_DATA_ROOT = {
  darwin: join(homedir(), 'Library'),
  win32: process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'),
}[platform()] ?? join(homedir(), '.local', 'share');
const DBEAVER_DIR =
  process.env.DBEAVER_CONFIG_DIR ?? join(DBEAVER_DATA_ROOT, 'DBeaverData', 'workspace6', 'General', '.dbeaver');
const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWLIST_PATH = process.env.DBEAVER_MCP_ALLOWLIST ?? join(HERE, 'allowlist.json');

// Chave fixa e pública do DBeaver para o credentials-config.json; não é segredo nosso.
const DBEAVER_CREDENTIALS_KEY = Buffer.from('babb4a9f774ab853c96c2d653dfe544a', 'hex');

const STATEMENT_TIMEOUT_MS = 15000;
const DEFAULT_MAX_ROWS = 200;
const HARD_MAX_ROWS = 2000;

function readCredentials() {
  const raw = readFileSync(join(DBEAVER_DIR, 'credentials-config.json'));
  const decipher = createDecipheriv('aes-128-cbc', DBEAVER_CREDENTIALS_KEY, raw.subarray(0, 16));
  return JSON.parse(Buffer.concat([decipher.update(raw.subarray(16)), decipher.final()]).toString('utf8'));
}

// Host que é apelido (CNAME) de outro nome não bate com o certificado, e o pg força servername = host.
function sslOptions({ ssl, caFile, tlsServerName }) {
  if (!caFile && !tlsServerName) return ssl ?? false;
  const options = {};
  if (caFile) options.ca = readFileSync(resolve(HERE, caFile), 'utf8');
  if (tlsServerName) {
    options.checkServerIdentity = (_host, cert) => checkServerIdentity(tlsServerName, cert);
  }
  return options;
}

function loadConnections() {
  const allowlist = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8')).connections ?? {};
  const dataSources = JSON.parse(readFileSync(join(DBEAVER_DIR, 'data-sources.json'), 'utf8')).connections ?? {};
  const credentials = readCredentials();

  const connections = new Map();
  for (const [id, source] of Object.entries(dataSources)) {
    const overrides = allowlist[source.name];
    if (!overrides) continue;
    if (source.provider !== 'postgresql') {
      throw new Error(`${source.name}: provider ${source.provider} ainda não suportado`);
    }
    const cfg = source.configuration ?? {};
    const secret = credentials[id]?.['#connection'] ?? {};
    connections.set(source.name, {
      name: source.name,
      host: cfg.host,
      port: Number(cfg.port ?? 5432),
      database: overrides.database ?? cfg.database,
      user: secret.user ?? cfg.user,
      password: secret.password,
      ssl: sslOptions(overrides),
    });
  }
  return connections;
}

const connections = loadConnections();
const pools = new Map();

function poolFor(name) {
  const conn = connections.get(name);
  if (!conn) {
    throw new Error(`Conexão "${name}" não está liberada. Liberadas: ${[...connections.keys()].join(', ') || 'nenhuma'}`);
  }
  if (!conn.password) {
    throw new Error(`"${name}" sem senha salva no DBeaver (marque "Save password" e não use o Secure Storage)`);
  }
  if (!pools.has(name)) {
    pools.set(
      name,
      new pg.Pool({
        host: conn.host,
        port: conn.port,
        database: conn.database,
        user: conn.user,
        password: conn.password,
        ssl: conn.ssl,
        max: 2,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        application_name: 'claude-dbeaver-readonly-mcp',
        options: `-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      }),
    );
  }
  return pools.get(name);
}

// Protocolo estendido aceita um único statement: impede "COMMIT; DROP ..." de escapar da transação READ ONLY.
async function runReadOnly(name, sql, params = [], maxRows = DEFAULT_MAX_ROWS) {
  const client = await poolFor(name).connect();
  try {
    await client.query('BEGIN READ ONLY');
    const result = await client.query({ text: sql, values: params, queryMode: 'extended', rowMode: 'object' });
    const rows = result.rows ?? [];
    const limit = Math.min(maxRows, HARD_MAX_ROWS);
    return {
      command: result.command,
      rowCount: result.rowCount,
      columns: result.fields?.map((f) => f.name),
      rows: rows.slice(0, limit),
      truncated: rows.length > limit,
    };
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

const asText = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const asError = (err) => ({ isError: true, content: [{ type: 'text', text: `ERRO: ${err.message}` }] });
const guarded = (fn) => async (args) => {
  try {
    return asText(await fn(args));
  } catch (err) {
    return asError(err);
  }
};

const server = new McpServer({ name: 'dbeaver-readonly', version: '0.1.0' });

server.tool(
  'list_connections',
  'Lista as conexões do DBeaver liberadas no allowlist (somente leitura).',
  {},
  guarded(async () =>
    [...connections.values()].map(({ name, host, port, database, user }) => ({ name, host, port, database, user })),
  ),
);

server.tool(
  'query',
  'Executa UM statement SQL em transação READ ONLY (timeout de 15s). Use $1, $2... com params.',
  {
    connection: z.string(),
    sql: z.string(),
    params: z.array(z.any()).optional(),
    max_rows: z.number().int().positive().optional(),
  },
  guarded(({ connection, sql, params, max_rows }) => runReadOnly(connection, sql, params ?? [], max_rows)),
);

server.tool(
  'list_tables',
  'Lista tabelas e views de um schema com o dono e se o usuário conectado tem SELECT.',
  { connection: z.string(), schema: z.string().optional() },
  guarded(({ connection, schema }) =>
    runReadOnly(
      connection,
      `SELECT c.relname AS name,
              CASE c.relkind WHEN 'r' THEN 'table' WHEN 'v' THEN 'view' WHEN 'm' THEN 'matview' WHEN 'p' THEN 'partitioned' END AS kind,
              pg_get_userbyid(c.relowner) AS owner,
              has_table_privilege(c.oid, 'SELECT') AS can_select,
              c.reltuples::bigint AS estimated_rows
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind IN ('r','v','m','p')
        ORDER BY c.relname`,
      [schema ?? 'public'],
      HARD_MAX_ROWS,
    ),
  ),
);

server.tool(
  'describe_table',
  'Mostra colunas, constraints e índices de uma tabela.',
  { connection: z.string(), table: z.string(), schema: z.string().optional() },
  guarded(async ({ connection, table, schema }) => {
    const params = [schema ?? 'public', table];
    const [columns, constraints, indexes] = await Promise.all([
      runReadOnly(
        connection,
        `SELECT column_name, data_type, character_maximum_length, is_nullable, column_default
           FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        params,
        HARD_MAX_ROWS,
      ),
      runReadOnly(
        connection,
        `SELECT con.conname AS name, pg_get_constraintdef(con.oid) AS definition
           FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 ORDER BY con.conname`,
        params,
        HARD_MAX_ROWS,
      ),
      runReadOnly(
        connection,
        `SELECT indexname AS name, indexdef AS definition FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
        params,
        HARD_MAX_ROWS,
      ),
    ]);
    return { columns: columns.rows, constraints: constraints.rows, indexes: indexes.rows };
  }),
);

await server.connect(new StdioServerTransport());
