import { migrate } from "../src/migrate.js";
await migrate(process.env.DATABASE_URL ?? "postgres://deepscan:deepscan@localhost:5432/deepscan");
