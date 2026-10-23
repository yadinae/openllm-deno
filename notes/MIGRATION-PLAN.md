# OpenLLM → FreeLLMAPI Migration Plan

## Phase 0: Core Proxy (P0-CORE)
1. [ ] Port proxy.ts (155KB) — HTTP proxy with streaming, multi-provider, error normalization
2. [ ] Mount routes/proxy.ts → /v1/* 
3. [ ] Complete embeddings.ts (20KB→5.6KB gap: batch, caching, OpenAI compat)
4. [ ] Complete responses.ts route (79KB→7KB gap)
5. [ ] Port anthropic-map.ts (9.8KB) — Anthropic → OpenAI translation
6. [ ] Port gemini-map.ts (2.7KB) — Gemini → OpenAI translation

## Phase 1: Keys & Auth (P1-KEYS-AUTH)
7. [ ] Port routes/keys.ts (86KB) — full Key CRUD (add/edit/delete/export/import/probe)
8. [ ] Extend services/auth.ts (6.7KB→1.9KB gap)
9. [ ] Port services/provider-credential.ts
10. [ ] Port services/declarative-config.ts (23KB)

## Phase 2: Scoring & Routing (P2-SCORING)
11. [ ] Extend ratelimit.ts (67KB→20KB) — multi-tier, token buckets
12. [ ] Extend fusion.ts (54KB→17KB) — multi-model fusion, streaming
13. [ ] Port penalty-inspector.ts service
14. [ ] Port model-weight-overrides.ts
15. [ ] Port degradation.ts
16. [ ] Port moderation.ts

## Phase 3: Schema & DB (P3-DB)
17. [ ] Migrate remaining SQLite tables to Postgres in pg.ts
18. [ ] Port services/backups.ts
19. [ ] Port services/request-retention.ts
20. [ ] Port services/idempotency.ts
21. [ ] Port services/context-handoff.ts

## Phase 4: Models & Discovery (P4-MODELS)
22. [ ] Port builtin-model-discovery.ts
23. [ ] Port model-discovery.ts
24. [ ] Port model-groups.ts
25. [ ] Port model-listing.ts
26. [ ] Port model-retirement.ts
27. [ ] Complete routes/models.ts (20.7KB→2.7KB gap)
28. [ ] Port routes/decisions.ts
29. [ ] Port routes/free-tier.ts

## Phase 5: Frontend Pages (P5-FRONTEND)
30. [ ] Port routes/keys.ts (frontend 86KB)
31. [ ] Port routes/models.ts (frontend)
32. [ ] Extend routes/analytics.ts (36KB→19.8KB)
33. [ ] Port routes/health.ts, status.ts, logs.ts
34. [ ] Port routes/profiles.ts, client-profiles.ts, conversations.ts
35. [ ] Port routes/settings.ts (28KB)
36. [ ] Port routes/mcp.ts, search.ts, cache.ts, compression.ts, docs.ts, backups.ts, update.ts, moderation.ts, url-tokens.ts

## Phase 6: Ops & Observation (P6-OBS)
37. [ ] Port services/cache.ts (31KB)
38. [ ] Port services/quota-outlook.ts

## Phase 7: Advanced (P7-ADV)
39. [ ] Port services/custom-endpoint.ts
40. [ ] Port services/custom-model-sync.ts, custom-model-tombstone.ts
41. [ ] Complete custom-model-budget.ts integration
