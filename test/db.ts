import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * An in-memory Postgres with a stand-in for Supabase's auth schema, roles and realtime
 * publication, and every migration in supabase/migrations applied.
 */
export async function leagueDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.jwt() returns jsonb language sql stable as
      $$ select nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
    create function auth.uid() returns uuid language sql stable as $$ select (auth.jwt() ->> 'sub')::uuid $$;
    create publication supabase_realtime;
    grant usage on schema public, auth to anon, authenticated, service_role;
    grant execute on all functions in schema auth to anon, authenticated, service_role;
    alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  `);
  const dir = join(import.meta.dirname, "..", "supabase", "migrations");
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) await db.exec(readFileSync(join(dir, f), "utf8"));

  let users = 0;
  /** Run SQL as a role; `discord` makes it a logged-in Discord user. Errors come back as { error }. */
  async function as<T = Record<string, unknown>>(role: "anon" | "authenticated" | "service_role", discord: string | null, sql: string, params: unknown[] = []) {
    const claims = discord ? { sub: await userId(discord), user_metadata: { name: `${discord}#0` } } : {};
    await db.query(`select set_config('request.jwt.claims', $1, false)`, [JSON.stringify(claims)]);
    await db.exec(`set role ${role}`);
    try {
      return { rows: (await db.query<T>(sql, params)).rows, error: null as string | null };
    } catch (e) {
      return { rows: [] as T[], error: (e as Error).message };
    } finally {
      await db.exec("reset role");
    }
  }
  const ids = new Map<string, string>();
  async function userId(discord: string) {
    if (!ids.has(discord)) {
      const id = `00000000-0000-0000-0000-${String(++users).padStart(12, "0")}`;
      await db.query("insert into auth.users values ($1)", [id]);
      ids.set(discord, id);
    }
    return ids.get(discord)!;
  }
  const member = (discord: string) => ({
    query: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => as<T>("authenticated", discord, sql, params),
  });
  return { db, as, member, service: <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => as<T>("service_role", null, sql, params) };
}
