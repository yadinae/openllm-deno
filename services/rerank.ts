/**
 * Rerank service — /v1/rerank
 * Proxies to Cohere or custom OpenAI-compatible /rerank endpoints.
 * Ported from FreeLLMAPI services/rerank.ts.
 */
import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";

export interface RerankResult {
  platform: string;
  modelId: string;
  results: { index: number; relevanceScore: number; document: string }[];
}

export class RerankError extends Error {
  status: number;
  code?: string;
  retryAfterMs?: number;
  constructor(message: string, status: number, code?: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

interface RerankCandidate {
  id: number;
  platform: string;
  key: string;
  baseUrl: string;
}

const FETCH_TIMEOUT_MS = 30_000;
const MAX_DOCUMENTS = 100;

async function getCandidates(): Promise<RerankCandidate[]> {
  const allKeys = await listApiKeys();
  const rows = allKeys.filter(
    (k) => k.enabled && k.status === "healthy" && (k.platform === "cohere" || k.platform === "custom")
  );
  const out: RerankCandidate[] = [];
  for (const row of rows) {
    if (row.platform === "custom" && !row.base_url) continue;
    try {
      const secret = await decryptKey(row.encrypted_key!, row.iv!, row.auth_tag!);
      out.push({ id: row.db_id, platform: row.platform, key: secret, baseUrl: row.base_url ?? "" });
    } catch {
      // undecryptable row
    }
  }
  // Custom endpoints first
  return out.sort((a, b) => (a.platform === "custom" ? -1 : 0) - (b.platform === "custom" ? -1 : 0));
}

async function callProvider(cand: RerankCandidate, model: string | undefined, query: string, documents: string[]): Promise<RerankResult> {
  const url = cand.platform === "cohere"
    ? "https://api.cohere.ai/v1/rerank"
    : `${cand.baseUrl.replace(/\/$/, "")}/rerank`;

  const payload: any = {
    model: model ?? (cand.platform === "cohere" ? "rerank-english-v3.0" : undefined),
    query,
    documents: documents.slice(0, MAX_DOCUMENTS),
    top_n: documents.length,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${cand.key}`,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });

  if (!res.ok) {
    const retryAfter = res.headers.get("retry-after");
    const retryAfterMs = retryAfter ? parseInt(retryAfter) * 1000 : undefined;
    const text = await res.text().catch(() => "");
    throw new RerankError(`upstream ${res.status}: ${text.slice(0, 200)}`, res.status, undefined, retryAfterMs);
  }

  const json = await res.json() as any;
  const results = json.results?.map((r: any) => ({ index: r.index, relevanceScore: r.relevance_score, document: r.document ?? documents[r.index] })) ?? [];
  return { platform: cand.platform, modelId: model ?? "rerank", results };
}

export async function runRerank(
  model: string | undefined,
  query: string,
  documents: string[],
): Promise<RerankResult> {
  if (!query || !documents.length) {
    throw new RerankError("query and documents are required", 400);
  }

  const candidates = await getCandidates();
  if (candidates.length === 0) {
    throw new RerankError("No rerank providers available. Add a Cohere or custom key.", 503);
  }

  let lastError: RerankError | null = null;
  for (const cand of candidates) {
    try {
      const result = await callProvider(cand, model, query, documents);
      return result;
    } catch (err: any) {
      const e = err instanceof RerankError ? err : new RerankError(String(err?.message ?? err), 502);
      lastError = e;
    }
  }

  const status = lastError?.status === 429 ? 429 : 502;
  throw new RerankError(
    `All rerank providers failed${lastError ? ` (last: ${lastError.message.slice(0, 160)})` : " (no usable keys)"}`,
    status,
  );
}