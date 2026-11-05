import pg from 'pg';
import { createTunnel } from 'tunnel-ssh';
import type { Server } from 'net';
import { config } from './config.js';
import { domainLookupVariants, normalizeDomain } from './domain.js';
import type { CompanyMetadata, PendingCompany, TokenUsage } from './types.js';

const { Pool } = pg;

let pool: pg.Pool | null = null;
let tunnelServer: Server | null = null;
let sshConnection: { end: () => void } | null = null;
let tunnelHealthy = true;
/** Set once close() begins, so tearing the tunnel down on purpose isn't reported as a failure. */
let closing = false;
/**
 * The batch job treats a dead tunnel as "stop, and let the next run retry".
 * A long-running server can't do that - it has to get the tunnel back. The
 * server switches this on; it changes nothing for the batch job.
 */
let autoRecover = false;
let poolPromise: Promise<pg.Pool> | null = null;
let recovering: Promise<void> | null = null;

const TABLE = config.database.table;

/**
 * "checked is not true", written so it can never throw on unexpected data.
 *
 * `(metadata->>'checked')::boolean` is the literal translation, but it raises
 * on any value that isn't boolean-ish, which would abort the whole batch
 * because one row has "yes please" in it. This form treats NULL, missing,
 * empty string and anything unrecognised as "not checked", which is exactly
 * the rows we want to pick up.
 */
const NOT_CHECKED = `COALESCE(lower(metadata->>'checked') IN ('true','t','yes','1','y'), false) IS NOT TRUE`;

/* ------------------------------------------------------------------ */
/* Connection                                                          */
/* ------------------------------------------------------------------ */

async function openSshTunnel(connectionString: string): Promise<string> {
  const dbUrl = new URL(connectionString);
  const dstAddr = dbUrl.hostname;
  const dstPort = Number(dbUrl.port || 5432);

  const sshOptions: Record<string, unknown> = {
    host: config.ssh.host,
    port: config.ssh.port,
    username: config.ssh.username,
    // The tunnel now carries several concurrent pg connections for a run that
    // may last minutes, instead of one connection used for a few seconds. Keep
    // the transport alive so an idle-timeout on the VPS's sshd doesn't drop it
    // mid-batch, and fail fast if the handshake itself hangs.
    readyTimeout: config.ssh.readyTimeoutMs,
    keepaliveInterval: 15_000,
    keepaliveCountMax: 4,
  };

  if (config.ssh.privateKey) {
    sshOptions.privateKey = config.ssh.privateKey;
    if (config.ssh.passphrase) sshOptions.passphrase = config.ssh.passphrase;
  } else if (config.ssh.password) {
    sshOptions.password = config.ssh.password;
    // Pinning SSH_HOST_FINGERPRINT is optional. When it's set, the connection
    // is verified against it and rejected on a mismatch. When it's not,
    // ssh2's default behaviour applies: it accepts whatever host key the
    // server presents, with no verification at all - there is no
    // ~/.ssh/known_hosts here to fall back on. That's a deliberate choice to
    // support environments where pinning isn't practical, but it does mean
    // password auth alone is what stands between this tunnel and a
    // man-in-the-middle, since (unlike key auth) there's no client-side
    // secret an attacker would additionally need.
    if (config.ssh.hostFingerprint) {
      sshOptions.hostHash = 'sha256';
      sshOptions.hostVerifier = (hashedKey: string): boolean => {
        const match = hashedKey.toLowerCase() === config.ssh.hostFingerprint?.toLowerCase();
        if (!match) {
          console.error(
            `[db] SSH host key fingerprint mismatch! Expected ${config.ssh.hostFingerprint}, ` +
              `got ${hashedKey}. Refusing to connect - this may be a man-in-the-middle.`
          );
        }
        return match;
      };
    } else {
      console.warn(
        '[db] SSH_PASSWORD is set without SSH_HOST_FINGERPRINT - connecting without host key ' +
          'verification. Set SSH_HOST_FINGERPRINT to pin the server\'s key (see SETUP.md "SSH by password").'
      );
    }
  } else {
    throw new Error(
      'SSH_TUNNEL_ENABLED is true but neither SSH_PRIVATE_KEY nor SSH_PASSWORD is set'
    );
  }

  const [server, connection] = await createTunnel(
    { autoClose: false, reconnectOnError: false },
    { host: '127.0.0.1', port: 0 },
    sshOptions,
    { dstAddr, dstPort }
  );

  tunnelServer = server as Server;
  sshConnection = connection as { end: () => void };

  // Without these, a tunnel that dies mid-run (network blip, sshd restart)
  // surfaces as an unhandled 'error' event and takes the whole process down
  // with it, losing the rest of the batch. Logged instead: the in-flight
  // queries fail, their rows record the error, and the next run reclaims them
  // once STALE_CLAIM_MS has passed.
  // Events from a tunnel we've already replaced (its teardown emits 'close')
  // must not mark the NEW tunnel unhealthy, hence the identity checks.
  const thisServer = tunnelServer;
  const thisConnection = sshConnection;
  const onTunnelError = (err: Error): void => {
    if (closing || sshConnection !== thisConnection) return;
    tunnelHealthy = false;
    console.error(`[db] SSH tunnel error: ${err.message}`);
  };
  (thisServer as unknown as { on(e: string, cb: (err: Error) => void): void }).on(
    'error',
    onTunnelError
  );
  (thisConnection as unknown as { on(e: string, cb: (err: Error) => void): void }).on(
    'error',
    onTunnelError
  );
  // A clean close (server dropped us, idle timeout) raises no 'error' event.
  (thisConnection as unknown as { on(e: string, cb: () => void): void }).on('close', () => {
    if (closing || sshConnection !== thisConnection) return;
    tunnelHealthy = false;
    console.error('[db] SSH connection closed.');
  });
  tunnelHealthy = true;

  const localPort = (tunnelServer.address() as { port: number }).port;
  console.log(
    `[db] SSH tunnel up: 127.0.0.1:${localPort} -> ${config.ssh.host} -> ${dstAddr}:${dstPort}`
  );

  dbUrl.hostname = '127.0.0.1';
  dbUrl.port = String(localPort);
  return dbUrl.toString();
}

async function createPool(): Promise<pg.Pool> {
  const connectionString = config.ssh.enabled
    ? await openSshTunnel(config.database.connectionString)
    : config.database.connectionString;

  pool = new Pool({
    connectionString,
    ssl: config.database.ssl ? { rejectUnauthorized: false } : undefined,
    // One connection per worker, plus a spare for the claim query. Through an
    // SSH tunnel each of these is a separate forwarded channel, so DATABASE_POOL_MAX
    // is there to cap it if the bastion's sshd is configured restrictively.
    max: config.database.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 15_000,
  });

  pool.on('error', (err) => console.error('[db] idle client error:', err.message));

  if (config.ssh.enabled) {
    console.log(`[db] Pool max ${config.database.poolMax} connection(s) over the SSH tunnel.`);
  }
  return pool;
}

/** Tears down a dead tunnel + pool so the next getPool() builds fresh ones. */
function recoverTransport(): Promise<void> {
  if (!recovering) {
    recovering = (async () => {
      console.warn('[db] SSH tunnel is down - rebuilding it and the connection pool.');
      const oldPool = pool;
      const oldServer = tunnelServer;
      const oldConnection = sshConnection;
      // Swap state BEFORE tearing anything down: the old tunnel's close events
      // then fail the identity check and are ignored, and "healthy" now refers
      // to the tunnel about to be built - otherwise every request arriving
      // while it connects would see "unhealthy" and tear that rebuild down.
      pool = null;
      poolPromise = null;
      tunnelServer = null;
      sshConnection = null;
      tunnelHealthy = true;
      // Not awaited: queries in flight on the dead tunnel may never resolve.
      if (oldPool) void oldPool.end().catch(() => undefined);
      try { oldServer?.close(); } catch { /* already closed */ }
      try { oldConnection?.end(); } catch { /* already closed */ }
    })().finally(() => {
      recovering = null;
    });
  }
  return recovering;
}

/**
 * One shared promise, so concurrent first callers - or concurrent callers
 * right after a recovery - build one pool and one tunnel between them.
 */
async function getPool(): Promise<pg.Pool> {
  if (poolPromise && autoRecover && config.ssh.enabled && !tunnelHealthy) {
    await recoverTransport();
  }
  if (!poolPromise) {
    poolPromise = createPool().catch((err) => {
      poolPromise = null;
      throw err;
    });
  }
  return poolPromise;
}

/** Called by the HTTP server: reconnect a dropped SSH tunnel instead of failing until restart. */
export function enableTransportRecovery(): void {
  autoRecover = true;
}

/* ------------------------------------------------------------------ */
/* Polling                                                             */
/* ------------------------------------------------------------------ */

/** How many rows are still waiting, for logging. */
export async function countPending(): Promise<number> {
  const client = await getPool();
  const { rows } = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${TABLE} WHERE ${NOT_CHECKED}`
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Claims up to `limit` unchecked rows and returns them.
 *
 * This is a single atomic UPDATE ... FROM (SELECT ... FOR UPDATE SKIP LOCKED)
 * rather than a plain SELECT, for two reasons:
 *
 *  - SKIP LOCKED means two overlapping runs (a slow Cloud Run execution still
 *    working when Scheduler fires the next one) never pick the same rows.
 *  - stamping `processing_started_at` means a row that was claimed but whose
 *    process died is invisible to other runs only until STALE_CLAIM_MS has
 *    passed, after which it becomes claimable again automatically.
 */
export async function claimPendingCompanies(limit: number): Promise<PendingCompany[]> {
  const client = await getPool();
  const staleSeconds = Math.max(1, Math.round(config.pipeline.staleClaimMs / 1000));

  const errorFilter = config.pipeline.retryErrored
    ? ''
    : `AND COALESCE(NULLIF(trim(metadata->>'errors'), ''), '') = ''`;

  const query = `
    UPDATE ${TABLE} AS t
       SET metadata   = t.metadata || jsonb_build_object('processing_started_at', to_jsonb(now())),
           updated_at = now()
      FROM (
            SELECT id
              FROM ${TABLE}
             WHERE ${NOT_CHECKED}
               AND COALESCE(NULLIF(trim(metadata->>'domain'), ''), NULLIF(trim(id), '')) IS NOT NULL
               ${errorFilter}
               AND (
                     metadata->>'processing_started_at' IS NULL
                  OR (metadata->>'processing_started_at')::timestamptz
                       < now() - make_interval(secs => $2::double precision)
                   )
             ORDER BY created_at ASC
             LIMIT $1
               FOR UPDATE SKIP LOCKED
           ) AS c
     WHERE t.id = c.id
 RETURNING t.id, t.metadata;
  `;

  const { rows } = await client.query<{ id: string; metadata: CompanyMetadata }>(query, [
    limit,
    staleSeconds,
  ]);

  return rows.map((row) => ({
    id: row.id,
    domain: String(row.metadata?.domain ?? row.id).trim(),
    metadata: row.metadata ?? {},
  }));
}

/* ------------------------------------------------------------------ */
/* Writing results back                                                */
/* ------------------------------------------------------------------ */

/**
 * Merges a partial metadata patch into the row's JSONB and accumulates token
 * counters on top of whatever was already there.
 *
 * Everything is a JSONB merge (`||`), never a replace, so the keys this
 * pipeline knows nothing about - record_id, row_number, created_by,
 * last_interaction_with, industry_thesis - survive untouched.
 *
 * Token counters are additive: a row reprocessed after an error shows total
 * spend across attempts, which is what you want when the point is tracking
 * cost. `last_run_usage` keeps the most recent call's breakdown on its own.
 */
export async function finishCompany(
  id: string,
  patch: Partial<CompanyMetadata>,
  usage?: TokenUsage
): Promise<void> {
  const client = await getPool();

  const query = `
    UPDATE ${TABLE} AS t
       SET metadata = (
             t.metadata
             || $2::jsonb
             || jsonb_build_object(
                  'input_tokens',
                    COALESCE(NULLIF(t.metadata->>'input_tokens','')::numeric, 0) + $3::numeric,
                  'output_tokens',
                    COALESCE(NULLIF(t.metadata->>'output_tokens','')::numeric, 0) + $4::numeric,
                  'cache_read_input_tokens',
                    COALESCE(NULLIF(t.metadata->>'cache_read_input_tokens','')::numeric, 0) + $5::numeric,
                  'cache_creation_input_tokens',
                    COALESCE(NULLIF(t.metadata->>'cache_creation_input_tokens','')::numeric, 0) + $6::numeric,
                  'last_run_usage', $7::jsonb
                )
           ) - 'processing_started_at',
           updated_at = now()
     WHERE t.id = $1;
  `;

  await client.query(query, [
    id,
    JSON.stringify(patch),
    usage?.input_tokens ?? 0,
    usage?.output_tokens ?? 0,
    usage?.cache_read_input_tokens ?? 0,
    usage?.cache_creation_input_tokens ?? 0,
    usage ? JSON.stringify(usage) : null,
  ]);
}

/**
 * Writes the crawl output into the two dedicated columns:
 *
 *   sitemap      TEXT   - URLs Tavily Map discovered, one per line
 *   scraped_text TEXT   - the exact text that was sent to the model
 *
 * Called right after the crawl and BEFORE the model call, so if the model
 * call then fails, the (paid-for) crawl is not lost. COALESCE means a value
 * that wasn't produced this time (e.g. the map step failed) never wipes one
 * saved by an earlier attempt.
 */
export async function saveScrapeData(
  id: string,
  data: { sitemap?: string[] | null; scrapedText?: string | null }
): Promise<void> {
  const client = await getPool();
  await client.query(
    `UPDATE ${TABLE}
        SET sitemap      = COALESCE($2::text, sitemap),
            scraped_text = COALESCE($3::text, scraped_text),
            updated_at   = now()
      WHERE id = $1`,
    [
      id,
      // One URL per line. Postgres TEXT rejects NUL, so strip it here too.
      data.sitemap && data.sitemap.length > 0
        ? data.sitemap.join('\n').replace(/\u0000/g, '')
        : null,
      // Postgres TEXT rejects NUL; the Firecrawl path doesn't pre-strip it.
      data.scrapedText ? data.scrapedText.replace(/\u0000/g, '') : null,
    ]
  );
}

/**
 * Fails at startup - with the fix spelled out - if the migration adding the
 * `sitemap` and `scraped_text` columns hasn't been run, instead of failing
 * on every row later.
 */
export async function assertScrapeColumns(): Promise<void> {
  const client = await getPool();
  const parts = TABLE.replace(/"/g, '').split('.');
  const table = parts.pop() as string;
  const schema = parts.pop() ?? 'public';

  const { rows } = await client.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
        AND column_name IN ('sitemap', 'scraped_text')`,
    [schema, table]
  );
  const have = new Map(rows.map((r) => [r.column_name, r.data_type]));
  const missing = ['sitemap', 'scraped_text'].filter((c) => !have.has(c));
  if (missing.length > 0) {
    throw new Error(
      `${TABLE} is missing column(s): ${missing.join(', ')}. ` +
        `Run migration.sql (or: ALTER TABLE ${TABLE} ADD COLUMN IF NOT EXISTS sitemap TEXT, ` +
        `ADD COLUMN IF NOT EXISTS scraped_text TEXT;)`
    );
  }
  if (have.get('sitemap') !== 'text') {
    throw new Error(
      `${TABLE}.sitemap must be TEXT but is ${have.get('sitemap')}. ` +
        `See step "0b" in migration.sql for the conversion (it keeps existing data).`
    );
  }
}

/** Clears the claim stamp without recording a result (used on shutdown). */
export async function releaseCompany(id: string): Promise<void> {
  const client = await getPool();
  await client.query(
    `UPDATE ${TABLE} SET metadata = metadata - 'processing_started_at', updated_at = now() WHERE id = $1`,
    [id]
  );
}

/** Totals for the whole table, printed at the end of each run. */
export async function tokenTotals(): Promise<{
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}> {
  const client = await getPool();
  const { rows } = await client.query<{
    input: string | null;
    output: string | null;
    cache_read: string | null;
    cache_write: string | null;
  }>(`
    SELECT sum(COALESCE(NULLIF(metadata->>'input_tokens','')::numeric, 0))::text  AS input,
           sum(COALESCE(NULLIF(metadata->>'output_tokens','')::numeric, 0))::text AS output,
           sum(COALESCE(NULLIF(metadata->>'cache_read_input_tokens','')::numeric, 0))::text AS cache_read,
           sum(COALESCE(NULLIF(metadata->>'cache_creation_input_tokens','')::numeric, 0))::text AS cache_write
      FROM ${TABLE}
  `);
  const row = rows[0];
  return {
    input: Number(row?.input ?? 0),
    output: Number(row?.output ?? 0),
    cacheRead: Number(row?.cache_read ?? 0),
    cacheWrite: Number(row?.cache_write ?? 0),
  };
}

/** False once the SSH tunnel has reported an error; the run should stop. */
export function isTransportHealthy(): boolean {
  return !config.ssh.enabled || tunnelHealthy;
}

/** A plain parameterised query on the shared pool (tunnel recovery included). */
export async function dbQuery<R extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<pg.QueryResult<R>> {
  const client = await getPool();
  return client.query<R>(text, params);
}

/** Cheap startup check so a bad DATABASE_URL fails loudly and immediately. */
export async function assertConnection(): Promise<void> {
  const client = await getPool();
  await client.query('SELECT 1');
}

export async function closePool(): Promise<void> {
  closing = true;
  poolPromise = null;
  if (pool) {
    await pool.end();
    pool = null;
  }
  if (tunnelServer) {
    tunnelServer.close();
    tunnelServer = null;
  }
  if (sshConnection) {
    sshConnection.end();
    sshConnection = null;
  }
}

/* ------------------------------------------------------------------ */
/* Lookup + on-demand processing (used by the HTTP API)                */
/* ------------------------------------------------------------------ */

/** metadata.checked is truthy. Same tolerant reading as NOT_CHECKED, inverted. */
const IS_CHECKED = `COALESCE(lower(metadata->>'checked') IN ('true','t','yes','1','y'), false)`;

/**
 * When the row was last checked: metadata.checked_at, or the row's updated_at
 * for rows that were checked before checked_at existed. The regex guard means
 * an unparseable checked_at falls back to updated_at instead of raising and
 * failing the whole lookup.
 */
const CHECKED_AT = `COALESCE(
  CASE WHEN metadata->>'checked_at' ~ '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])[T ]'
       THEN (metadata->>'checked_at')::timestamptz END,
  updated_at)`;

/** True when nobody holds a live claim on the row (no stamp, or one older than STALE_CLAIM_MS). */
const claimIsFree = (col: string, secsParam: string): string =>
  `(${col}->>'processing_started_at' IS NULL
     OR (${col}->>'processing_started_at')::timestamptz
          < now() - make_interval(secs => ${secsParam}::double precision))`;

export interface CompanyRecord {
  id: string;
  /** Normalised bare host, e.g. "acme.com". */
  domain: string;
  metadata: CompanyMetadata;
  isChecked: boolean;
  /** Checked, and checked within the configured freshness window. */
  isFresh: boolean;
  checkedAt: Date | null;
}

interface RecordRow {
  id: string;
  metadata: CompanyMetadata | null;
  is_checked: boolean;
  is_fresh: boolean;
  checked_at: Date | null;
}

const RECORD_COLUMNS = `
  id, metadata,
  ${IS_CHECKED} AS is_checked,
  ${CHECKED_AT} AS checked_at,
  (${IS_CHECKED} AND ${CHECKED_AT} >= now() - make_interval(months => $2::int)) AS is_fresh`;

function rowDomain(row: { id: string; metadata: CompanyMetadata | null }): string | null {
  const fromMeta = row.metadata?.domain;
  const raw = typeof fromMeta === 'string' && fromMeta.trim() ? fromMeta : row.id;
  return normalizeDomain(raw);
}

function toRecord(row: RecordRow, domain: string): CompanyRecord {
  return {
    id: row.id,
    domain,
    metadata: row.metadata ?? {},
    isChecked: row.is_checked,
    isFresh: row.is_fresh,
    checkedAt: row.checked_at,
  };
}

/** Best row wins when a domain appears more than once: fresh, then checked, then newest. */
function better(a: CompanyRecord, b: CompanyRecord): CompanyRecord {
  if (a.isFresh !== b.isFresh) return a.isFresh ? a : b;
  if (a.isChecked !== b.isChecked) return a.isChecked ? a : b;
  return (a.checkedAt?.getTime() ?? 0) >= (b.checkedAt?.getTime() ?? 0) ? a : b;
}

/**
 * One query for any number of already-normalised domains. Returns a map keyed
 * by normalised domain; domains with no row are simply absent.
 */
export async function findCompaniesByDomains(
  domains: string[]
): Promise<Map<string, CompanyRecord>> {
  const found = new Map<string, CompanyRecord>();
  if (domains.length === 0) return found;

  const wanted = new Set(domains);
  const variants = [...new Set(domains.flatMap(domainLookupVariants))];
  const client = await getPool();
  const { rows } = await client.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS}
       FROM ${TABLE}
      WHERE lower(metadata->>'domain') = ANY($1::text[])
         OR id = ANY($1::text[])`,
    [variants, config.api.resultMaxAgeMonths]
  );

  for (const row of rows) {
    const domain = rowDomain(row);
    if (!domain || !wanted.has(domain)) continue;
    const record = toRecord(row, domain);
    const current = found.get(domain);
    found.set(domain, current ? better(current, record) : record);
  }
  return found;
}

export async function findCompanyById(id: string): Promise<CompanyRecord | null> {
  const client = await getPool();
  const { rows } = await client.query<RecordRow>(
    `SELECT ${RECORD_COLUMNS} FROM ${TABLE} WHERE id = $1`,
    [id, config.api.resultMaxAgeMonths]
  );
  const row = rows[0];
  if (!row) return null;
  const domain = rowDomain(row);
  return domain ? toRecord(row, domain) : null;
}

/**
 * Takes the processing claim on a company, creating the row if it doesn't
 * exist. Returns null when someone else (another API instance, or the batch
 * job) holds a live claim - the caller should wait, not process it twice.
 *
 * This is the same `processing_started_at` stamp claimPendingCompanies() uses,
 * so a row the API is working on is invisible to the batch poller, and vice
 * versa. It deliberately does NOT touch updated_at: for legacy rows that lack
 * checked_at, updated_at is the "last checked" date, and merely starting a
 * refresh must not make a stale row look fresh.
 *
 * A row that is already checked stays checked while it is being refreshed, so
 * if the process dies mid-way the old result is still there and simply gets
 * refreshed again by the next request.
 */
export async function claimForProcessing(params: {
  domain: string;
  existingId?: string;
  name?: string | null;
}): Promise<PendingCompany | null> {
  const client = await getPool();
  const staleSeconds = Math.max(1, Math.round(config.pipeline.staleClaimMs / 1000));
  const namePatch = params.name ? { name: params.name } : {};
  const stamp = `jsonb_build_object('processing_started_at', to_jsonb(now()))`;

  let rows: { id: string; metadata: CompanyMetadata }[];

  if (params.existingId) {
    ({ rows } = await client.query(
      `UPDATE ${TABLE} AS t
          SET metadata = t.metadata || $2::jsonb || ${stamp}
        WHERE t.id = $1
          AND ${claimIsFree('t.metadata', '$3')}
    RETURNING t.id, t.metadata`,
      [params.existingId, JSON.stringify(namePatch), staleSeconds]
    ));
  } else {
    // ON CONFLICT covers two requests racing to create the same domain: the
    // loser falls into the UPDATE branch, finds the winner's fresh stamp, and
    // gets no row back.
    ({ rows } = await client.query(
      `INSERT INTO ${TABLE} AS t (id, metadata)
       VALUES ($1, $2::jsonb || ${stamp})
       ON CONFLICT (id) DO UPDATE
          SET metadata = t.metadata || $3::jsonb || ${stamp}
        WHERE ${claimIsFree('t.metadata', '$4')}
    RETURNING t.id, t.metadata`,
      [
        params.domain,
        JSON.stringify({ domain: params.domain, added_via: 'api', ...namePatch }),
        JSON.stringify(namePatch),
        staleSeconds,
      ]
    ));
  }

  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    domain: String(row.metadata?.domain ?? row.id).trim(),
    metadata: row.metadata ?? {},
  };
}

/** Drops the claim stamp without recording a result and without touching updated_at. */
export async function releaseClaim(id: string): Promise<void> {
  const client = await getPool();
  await client.query(`UPDATE ${TABLE} SET metadata = metadata - 'processing_started_at' WHERE id = $1`, [
    id,
  ]);
}
