/** Hybrid retrieval: Postgres full-text (lexical) + pgvector (hashed embedding), fused with Reciprocal Rank Fusion. */
import { sql } from "kysely";
import type { z } from "zod";
import type { Db } from "@deepscan/platform";
import { WcagSc, type SearchHit, type SearchRequest } from "@deepscan/contracts";
import { embed, toPgVector, tokens } from "./embed.js";

type Hit = z.output<typeof SearchHit>;
type Row = { id: string; kind: string; sc: string[]; title: string; text: string; url: string };

export async function hybridSearch(db: Db, req: z.output<typeof SearchRequest>): Promise<Hit[]> {
  const kinds = req.kinds?.length ? req.kinds : null;
  const kindFilter = kinds ? sql`AND kind = ANY(${kinds})` : sql``;
  const vec = toPgVector(embed(req.query));
  const terms = [...new Set(tokens(req.query).map((t) => t.replace(/[^a-z0-9]/g, "")).filter((t) => t.length > 1))].slice(0, 20);

  const vector = await sql<Row>`
    SELECT id, kind, sc, title, text, url FROM rag_chunks
    WHERE true ${kindFilter}
    ORDER BY embedding <=> ${vec}::vector LIMIT 20`.execute(db);
  const lexical = terms.length
    ? await sql<Row>`
        SELECT id, kind, sc, title, text, url FROM rag_chunks, to_tsquery('english', ${terms.join(" | ")}) q
        WHERE tsv @@ q ${kindFilter}
        ORDER BY ts_rank_cd(tsv, q) DESC LIMIT 20`.execute(db)
    : { rows: [] as Row[] };

  const mentioned = new Set(req.query.match(/\b\d\.\d\.\d{1,2}\b/g) ?? []);
  const scores = new Map<string, { row: Row; score: number }>();
  const add = (rows: Row[], w: number) =>
    rows.forEach((row, rank) => {
      const e = scores.get(row.id) ?? { row, score: 0 };
      e.score += w / (60 + rank + 1);
      scores.set(row.id, e);
    });
  add(vector.rows, 1);
  add(lexical.rows, 1);
  for (const e of scores.values()) if (e.row.sc.some((s) => mentioned.has(s))) e.score += 0.05;

  return [...scores.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, req.k)
    .map(({ row, score }) => ({
      id: row.id,
      kind: row.kind as Hit["kind"],
      sc: row.sc.filter((s): s is z.infer<typeof WcagSc> => WcagSc.safeParse(s).success),
      title: row.title,
      text: row.text,
      url: row.url,
      score: Number(score.toFixed(5)),
    }));
}
