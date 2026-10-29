import pg from "pg";
import { SCHEMA_SQL } from "./schema.js";

/** Apply the schema under a cluster-wide advisory lock (safe with N replicas / Jobs). */
export async function migrate(databaseUrl: string, log: (m: string) => void = console.log) {
  let client: pg.Client;
  for (let i = 0; ; i++) {
    client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      break;
    } catch (e) {
      await client.end().catch(() => {});
      if (i >= 30) throw e;
      log(`waiting for database (${(e as Error).message})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try {
    await client.query("SELECT pg_advisory_lock(727274)");
    await client.query(SCHEMA_SQL);
    log("schema up to date");
  } finally {
    await client.query("SELECT pg_advisory_unlock(727274)").catch(() => {});
    await client.end();
  }
}
