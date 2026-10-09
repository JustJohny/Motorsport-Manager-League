import { existsSync } from "node:fs";
import { request } from "node:https";

export interface SupabaseEnv {
  url: string;
  serviceKey: string;
  /** The series every request is for (sent as the x-series header). */
  series?: string;
}

/** SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from the environment or ./.env. */
export function supabaseEnv(): SupabaseEnv {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const url = process.env.SUPABASE_URL, serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error("set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (e.g. in .env, see .env.example)");
  return { url: url.replace(/\/$/, ""), serviceKey };
}

/**
 * Call Supabase's REST API with the service key, which bypasses row-level security.
 * Uses node:https (HTTP/1.1): Node's fetch negotiates HTTP/2 with Supabase, and large uploads over
 * it failed intermittently ("bad record mac", ERR_HTTP2_INVALID_SESSION). Network errors are
 * retried, so only use this for requests that are safe to repeat.
 */
export async function rest<T>(env: SupabaseEnv, method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await restOnce<T>(env, method, path, body);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code || attempt === 3) throw e;
      console.error(`network error (${code}), retrying…`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

function restOnce<T>(env: SupabaseEnv, method: string, path: string, body?: unknown): Promise<T> {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = request(`${env.url}/rest/v1/${path}`, {
      method,
      headers: {
        apikey: env.serviceKey,
        // Legacy service_role keys are JWTs and also go in Authorization; new sb_secret_ keys must not.
        ...(env.serviceKey.startsWith("sb_") ? {} : { authorization: `Bearer ${env.serviceKey}` }),
        ...(data ? { "content-type": "application/json", "content-length": data.length } : {}),
        prefer: "return=representation",
        ...(env.series ? { "x-series": env.series } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) reject(new Error(`${method} ${path.split("?")[0]} failed: ${status} ${text}`));
        else resolve((text ? JSON.parse(text) : null) as T);
      });
    });
    req.on("error", reject);
    req.end(data);
  });
}

function authHeaders(env: SupabaseEnv) {
  return { apikey: env.serviceKey, ...(env.serviceKey.startsWith("sb_") ? {} : { authorization: `Bearer ${env.serviceKey}` }) };
}

function storageOnce(env: SupabaseEnv, method: string, path: string, body?: Buffer, contentType?: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(`${env.url}/storage/v1/${path}`, {
      method,
      headers: {
        ...authHeaders(env),
        ...(body ? { "content-type": contentType ?? "application/octet-stream", "content-length": body.length, "x-upsert": "true" } : {}),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        const out = Buffer.concat(chunks);
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) reject(new Error(`${method} storage ${path} failed: ${status} ${out.toString("utf8")}`));
        else resolve(out);
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function storage(env: SupabaseEnv, method: string, path: string, body?: Buffer, contentType?: string): Promise<Buffer> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await storageOnce(env, method, path, body, contentType);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // Some connections corrupt TLS records now and then ("bad record mac"), large bodies more often.
      if (!code || attempt === 6) throw e;
      console.error(`network error (${code}), retrying…`);
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}

/** Upload (or replace) a file in a Storage bucket with the service key. */
export function storageUpload(env: SupabaseEnv, bucket: string, name: string, data: Buffer, contentType: string): Promise<Buffer> {
  return storage(env, "POST", `object/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}`, data, contentType);
}

/** Download a file from a Storage bucket with the service key. */
export function storageDownload(env: SupabaseEnv, bucket: string, name: string): Promise<Buffer> {
  return storage(env, "GET", `object/${bucket}/${name.split("/").map(encodeURIComponent).join("/")}`);
}

export interface SeriesBackup {
  series: { id: string; name: string; created_at: string };
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

/**
 * The same backup as the export_series() RPC, read a page of one table at a time
 * (export_series_rows, migration 025): one statement for everything hits Supabase's statement
 * timeout on a long league. A page that still times out is retried at half the size.
 */
export async function exportSeries(env: SupabaseEnv, log: (line: string) => void = () => {}): Promise<SeriesBackup> {
  const [series] = await rest<SeriesBackup["series"][]>(env, "GET", `series?id=eq.${encodeURIComponent(env.series ?? "")}`);
  if (!series) throw new Error(`No series ${env.series ?? "(none: set \"series\" in the league file)"}`);
  const backup: SeriesBackup = { series, exportedAt: new Date().toISOString(), tables: {} };
  for (const t of await rest<string[]>(env, "POST", "rpc/series_tables", {})) {
    const rows: unknown[] = [];
    for (let take = 200; ;) {
      let page: unknown[];
      try {
        page = await rest<unknown[]>(env, "POST", "rpc/export_series_rows", { t, skip: rows.length, take });
      } catch (e) {
        if (!/57014/.test(String(e)) || take === 1) throw e;
        take = Math.max(1, take >> 1);
        log(`${t}: timed out, retrying ${take} rows at a time`);
        continue;
      }
      rows.push(...page);
      if (page.length < take) break;
    }
    backup.tables[t] = rows;
  }
  return backup;
}
