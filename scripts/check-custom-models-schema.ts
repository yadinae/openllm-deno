import { initDb, query } from "../db/pg.ts";
await initDb();
const rows = await query`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'custom_models'`;
console.log(JSON.stringify(rows, null, 2));