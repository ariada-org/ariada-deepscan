/** Entry point for the db-migrate Kubernetes Job. */
import { migrate, loadEnv, DbEnv } from "@deepscan/platform";
const env = loadEnv(DbEnv);
await migrate(env.DATABASE_URL);
process.exit(0);
