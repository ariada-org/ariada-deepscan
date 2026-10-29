import { z } from "zod";
import { WcagSc, RagDocKind, understandingUrl } from "@deepscan/contracts";
import raw from "../corpus/wcag-corpus.json" with { type: "json" };

export const CorpusDoc = z.object({
  id: z.string(),
  kind: RagDocKind,
  sc: z.array(WcagSc),
  title: z.string(),
  text: z.string(),
  url: z.string(),
});
export type CorpusDoc = z.infer<typeof CorpusDoc>;

/** The corpus is validated against the same contracts as everything else. */
export const CORPUS: CorpusDoc[] = z
  .array(CorpusDoc)
  .parse(raw.docs)
  .map((d) => ({ ...d, url: d.url || (d.sc[0] ? understandingUrl(d.sc[0]) : "") }));
