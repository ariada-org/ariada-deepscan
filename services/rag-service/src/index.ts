import { z } from "zod";
import { SearchRequest, SearchResponse, ScDetail, WcagSc, scInfo, understandingUrl } from "@deepscan/contracts";
import { BaseEnv, DbEnv, loadEnv, createService, listen, createDb, counter } from "@deepscan/platform";
import { hybridSearch } from "./search.js";
import { CORPUS } from "./corpus.js";

const env = loadEnv(BaseEnv.extend(DbEnv.shape));
const { db, ping } = createDb(env.DATABASE_URL, env.DB_POOL_MAX);
const searches = counter("rag_searches_total", "RAG searches served");

const app = await createService({ name: "rag-service", podName: env.POD_NAME, logLevel: env.LOG_LEVEL, ready: ping });

app.post("/search", { schema: { body: SearchRequest, response: { 200: SearchResponse } } }, async (req) => {
  const hits = await hybridSearch(db, req.body);
  searches.inc();
  req.log.info({ query: req.body.query, top: hits.map((h) => h.id) }, "search");
  return { hits, mode: "hybrid: postgres-fts + pgvector(hashed-256), RRF k=60" };
});

app.get("/sc/:sc", { schema: { params: z.object({ sc: WcagSc }), response: { 200: ScDetail } } }, async (req) => {
  const sc = req.params.sc;
  const info = scInfo(sc);
  const summary = CORPUS.find((d) => d.id === `sc-${sc}`)?.text ?? "";
  const related = CORPUS.filter((d) => d.kind !== "sc" && d.sc.includes(sc)).map((d) => ({ id: d.id, kind: d.kind, title: d.title }));
  return { sc, title: info.title, level: info.level, appliesTo: info.appliesTo === "any" ? ("any" as const) : [...info.appliesTo], summary, url: understandingUrl(sc), related };
});

await listen(app, env.PORT);
