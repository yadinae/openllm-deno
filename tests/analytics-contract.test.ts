import { Hono } from "hono";
import analyticsRouter from "../routes/analytics.ts";

// Mount only the analytics router (bypasses main.ts session gate) and hit every
// endpoint with DATABASE_URL unset, so initDb() throws and each handler takes
// its catch path. Guards the /agents crash: array endpoints must return a JSON
// ARRAY (SPA calls .filter on them); an object envelope is the bug.
const app = new Hono();
app.route("/api/analytics", analyticsRouter);

const ARRAY_ENDPOINTS = [
  "/api/analytics/by-model",
  "/api/analytics/by-platform",
  "/api/analytics/by-client",
  "/api/analytics/by-key",
  "/api/analytics/timeline",
  "/api/analytics/errors",
];

Deno.test("analytics array endpoints return JSON arrays (SPA .filter safe)", async () => {
  for (const path of ARRAY_ENDPOINTS) {
    const res = await app.request(path + "?range=30d");
    const body = await res.json();
    if (!Array.isArray(body)) {
      throw new Error(`${path} returned ${typeof body}, not an array -> SPA .filter crash`);
    }
  }
});

Deno.test("analytics object endpoints return objects (not arrays)", async () => {
  const OBJECT_ENDPOINTS = [
    "/api/analytics/summary",
    "/api/analytics/error-distribution",
    "/api/analytics/requests",
    "/api/analytics/search",
  ];
  for (const path of OBJECT_ENDPOINTS) {
    const res = await app.request(path + "?range=30d");
    const body = await res.json();
    if (Array.isArray(body)) throw new Error(`${path} returned an array, expected object`);
  }
});
