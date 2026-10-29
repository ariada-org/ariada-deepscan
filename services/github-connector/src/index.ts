import cookie from "@fastify/cookie";
import { createService, listen, createDb, migrate } from "@deepscan/platform";
import { env, appConfigured } from "./env.js";
import { registerWebhooks } from "./webhooks.js";
import { registerAuth } from "./auth.js";
import { registerRoutes } from "./routes.js";
import { startEventWorker } from "./events.js";
import { startPublisher } from "./publisher.js";
import { ensureRepo, FIXTURE_REPO_NAME } from "./boot.js";

const { db, ping } = createDb(env.DATABASE_URL, env.DB_POOL_MAX);
const app = await createService({ name: "github-connector", podName: env.POD_NAME, logLevel: env.LOG_LEVEL, ready: ping });
await app.register(cookie);

registerWebhooks(app, db);
registerAuth(app, db);
registerRoutes(app, db);

await migrate(env.DATABASE_URL, (m) => app.log.info(m));
if (env.FIXTURES_DIR) {
  await ensureRepo(db, { fullName: FIXTURE_REPO_NAME, source: "fixture", defaultBranch: "main", siteUrl: env.DEMO_SITE_URL ?? null });
}
app.log.info({ appConfigured }, "github-connector starting");
startEventWorker(db, app.log);
startPublisher(db, app.log);
await listen(app, env.PORT);
