import { DatabaseSync } from "node:sqlite";
import { Pool, type PoolClient } from "pg";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config";
export interface DB {
  query<T = any>(sql: string, params?: any[]): Promise<T[]>;
  transaction<T>(fn: (db: DB) => Promise<T>): Promise<T>;
}
let instance: Promise<DB> | undefined;
export function database(): Promise<DB> {
  return (instance ??= open());
}
async function open(): Promise<DB> {
  const c = config();
  let db: DB;
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 8,
    });
    const wrap = (client: Pool | PoolClient): DB => ({
      query: async (sql, params = []) => (await client.query(sql, params)).rows,
      transaction: async (fn) => {
        const conn = await pool.connect();
        try {
          await conn.query("BEGIN");
          const result = await fn(wrap(conn));
          await conn.query("COMMIT");
          return result;
        } catch (e) {
          await conn.query("ROLLBACK");
          throw e;
        } finally {
          conn.release();
        }
      },
    });
    db = wrap(pool);
  } else {
    if (c.mode === "live" && !c.localOnly)
      throw new Error("Public hosting requires PostgreSQL");
    mkdirSync(c.data, { recursive: true });
    const sqlite = new DatabaseSync(path.join(c.data, "forma.sqlite"));
    sqlite.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;",
    );
    let tail = Promise.resolve();
    const raw = async (sql: string, params: any[] = []) => {
      sql = sql.replace(/\bFOR UPDATE\b/g, "");
      const args: any[] = [];
      sql = sql.replace(/\$(\d+)/g, (_, n) => {
        args.push(params[Number(n) - 1]);
        return "?";
      });
      return sqlite.prepare(sql).all(...args) as any[];
    };
    const queue = <T>(fn: () => Promise<T>) => {
      const next = tail.then(fn);
      tail = next.then(
        () => {},
        () => {},
      );
      return next;
    };
    const direct: DB = { query: raw, transaction: async (fn) => fn(direct) };
    db = {
      query: (sql, params) => queue(() => raw(sql, params)),
      transaction: (fn) =>
        queue(async () => {
          sqlite.exec("BEGIN IMMEDIATE");
          try {
            const result = await fn(direct);
            sqlite.exec("COMMIT");
            return result;
          } catch (e) {
            sqlite.exec("ROLLBACK");
            throw e;
          }
        }),
    };
  }
  const migration = readFileSync(
    path.join(process.cwd(), "migrations", "001_initial.sql"),
    "utf8",
  );
  for (const sql of migration
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean))
    await db.query(sql);
  return db;
}
