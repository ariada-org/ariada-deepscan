/** K8s Job: load the WCAG corpus into Postgres (FTS column + pgvector embedding). */
import { sql } from "kysely";
import { loadEnv, DbEnv, createDb, migrate, pino } from "@deepscan/platform";
import { CORPUS } from "./corpus.js";
import { embed, toPgVector } from "./embed.js";

const env = loadEnv(DbEnv);
const log = pino({ base: { service: "rag-ingest" } });
await migrate(env.DATABASE_URL, (m) => log.info(m));
const { db, pool } = createDb(env.DATABASE_URL, 2);
await db.transaction().execute(async (tx) => {
  for (const d of CORPUS) {
    const row = { id: d.id, kind: d.kind, sc: d.sc, title: d.title, text: d.text, url: d.url, embedding: toPgVector(embed(`${d.title}. ${d.text}`)) };
    await tx.insertInto("rag_chunks").values(row).onConflict((oc) => oc.column("id").doUpdateSet({ kind: row.kind, sc: row.sc, title: row.title, text: row.text, url: row.url, embedding: row.embedding })).execute();
  }
  await tx.deleteFrom("rag_chunks").where("id", "not in", CORPUS.map((d) => d.id)).execute();
});
const n = await db.selectFrom("rag_chunks").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
log.info({ chunks: n.n }, "corpus ingested");
await pool.end();
