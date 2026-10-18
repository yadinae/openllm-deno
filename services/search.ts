/**
 * Search Service — Web search for P-CORE-009.
 * Phase C Week 13-14: Embeddings / Media / Search core capabilities.
 *
 * Supports: Brave, Serper, SerpAPI, Google Custom Search, Bing, Tavily, Exa, etc.
 */

import { providerRegistry, initializeRegistry } from "../providers/index.ts";
import type { ProviderAdapter, ApiKey } from "../providers/types.ts";

initializeRegistry();

export type SearchEngine = "brave" | "serper" | "serpapi" | "google" | "bing" | "tavily" | "exa" | "duckduckgo";

export interface SearchRequest {
  query: string;
  engine?: SearchEngine;
  count?: number;
  offset?: number;
  safe_search?: boolean;
  freshness?: "day" | "week" | "month" | "year";
  site?: string;
  language?: string;
  country?: string;
}

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  published_date?: string;
  source?: string;
  score?: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  total_results?: number;
  search_time_ms: number;
  engine: string;
}

export interface SearchEngineInfo {
  id: SearchEngine;
  name: string;
  provider: string;
  capabilities: {
    web: boolean;
    news: boolean;
    academic: boolean;
    realtime: boolean;
  };
  rate_limit: { rpm: number; daily: number };
  pricing: { per_1k_queries: number; currency: string };
}

const SEARCH_ENGINES: Record<SearchEngine, SearchEngineInfo> = {
  brave: {
    id: "brave",
    name: "Brave Search",
    provider: "brave",
    capabilities: { web: true, news: true, academic: false, realtime: true },
    rate_limit: { rpm: 20, daily: 2000 },
    pricing: { per_1k_queries: 3.0, currency: "USD" },
  },
  serper: {
    id: "serper",
    name: "Serper.dev (Google)",
    provider: "serper",
    capabilities: { web: true, news: true, academic: false, realtime: true },
    rate_limit: { rpm: 100, daily: 10000 },
    pricing: { per_1k_queries: 5.0, currency: "USD" },
  },
  serpapi: {
    id: "serpapi",
    name: "SerpAPI (Google/Bing)",
    provider: "serpapi",
    capabilities: { web: true, news: true, academic: true, realtime: true },
    rate_limit: { rpm: 100, daily: 10000 },
    pricing: { per_1k_queries: 5.0, currency: "USD" },
  },
  google: {
    id: "google",
    name: "Google Custom Search",
    provider: "google",
    capabilities: { web: true, news: false, academic: false, realtime: false },
    rate_limit: { rpm: 100, daily: 10000 },
    pricing: { per_1k_queries: 5.0, currency: "USD" },
  },
  bing: {
    id: "bing",
    name: "Bing Search API",
    provider: "bing",
    capabilities: { web: true, news: true, academic: false, realtime: true },
    rate_limit: { rpm: 1000, daily: 100000 },
    pricing: { per_1k_queries: 3.0, currency: "USD" },
  },
  tavily: {
    id: "tavily",
    name: "Tavily AI Search",
    provider: "tavily",
    capabilities: { web: true, news: false, academic: false, realtime: true },
    rate_limit: { rpm: 100, daily: 10000 },
    pricing: { per_1k_queries: 5.0, currency: "USD" },
  },
  exa: {
    id: "exa",
    name: "Exa Neural Search",
    provider: "exa",
    capabilities: { web: true, news: false, academic: true, realtime: true },
    rate_limit: { rpm: 100, daily: 10000 },
    pricing: { per_1k_queries: 10.0, currency: "USD" },
  },
  duckduckgo: {
    id: "duckduckgo",
    name: "DuckDuckGo HTML",
    provider: "duckduckgo",
    capabilities: { web: true, news: false, academic: false, realtime: true },
    rate_limit: { rpm: 30, daily: 1000 },
    pricing: { per_1k_queries: 0, currency: "USD" },
  },
};

/** Get adapter for a provider */
function getSearchAdapter(provider: string): ProviderAdapter | null {
  const entry = providerRegistry.getEntry(provider);
  if (!entry) return null;
  return entry.adapter;
}

/** Perform web search */
export async function search(
  req: SearchRequest,
  apiKey: ApiKey
): Promise<SearchResponse> {
  const engine = req.engine ?? "brave";
  const engineInfo = SEARCH_ENGINES[engine];
  
  if (!engineInfo) {
    throw new Error(`Search engine ${engine} not supported`);
  }

  const adapter = getSearchAdapter(engineInfo.provider);
  if (!adapter) {
    throw new Error(`Provider ${engineInfo.provider} not found for search`);
  }

  const startTime = Date.now();
  
  // Each engine has different API format
  let results: SearchResult[];
  
  switch (engine) {
    case "brave":
      results = await searchBrave(req, adapter, apiKey);
      break;
    case "serper":
      results = await searchSerper(req, adapter, apiKey);
      break;
    case "serpapi":
      results = await searchSerpApi(req, adapter, apiKey);
      break;
    case "google":
      results = await searchGoogle(req, adapter, apiKey);
      break;
    case "bing":
      results = await searchBing(req, adapter, apiKey);
      break;
    case "tavily":
      results = await searchTavily(req, adapter, apiKey);
      break;
    case "exa":
      results = await searchExa(req, adapter, apiKey);
      break;
    case "duckduckgo":
      results = await searchDuckDuckGo(req);
      break;
    default:
      throw new Error(`Search engine ${engine} not implemented`);
  }

  const searchTimeMs = Date.now() - startTime;

  return {
    query: req.query,
    results,
    search_time_ms: searchTimeMs,
    engine,
  };
}

/** Brave Search API */
async function searchBrave(req: SearchRequest, adapter: ProviderAdapter, apiKey: ApiKey): Promise<SearchResult[]> {
  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/res/v1/web/search`);
  url.searchParams.set("q", req.query);
  url.searchParams.set("count", String(req.count ?? 10));
  url.searchParams.set("offset", String(req.offset ?? 0));
  if (req.freshness) url.searchParams.set("freshness", req.freshness);
  if (req.safe_search !== undefined) url.searchParams.set("safe_search", String(req.safe_search));
  if (req.site) url.searchParams.set("site", req.site);

  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json", "X-Subscription-Token": apiKey.encrypted_key },
  });

  if (!res.ok) throw new Error(`Brave search failed: ${res.status}`);
  
  const data = await res.json() as { web?: { results: Array<{ title: string; url: string; description: string; age?: string }> } };
  return (data.web?.results ?? []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.description,
    published_date: r.age,
    source: "brave",
  }));
}

/** Serper.dev (Google) */
async function searchSerper(req: SearchRequest, adapter: ProviderAdapter, apiKey: ApiKey): Promise<SearchResult[]> {
  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey.encrypted_key },
    body: JSON.stringify({
      q: req.query,
      num: req.count ?? 10,
      gl: req.country ?? "us",
      hl: req.language ?? "en",
      safe: req.safe_search ? "active" : "off",
      ...(req.freshness && { tbs: `qdr:${req.freshness[0]}` }),
    }),
  });

  if (!res.ok) throw new Error(`Serper search failed: ${res.status}`);
  
  const data = await res.json() as { organic: Array<{ title: string; link: string; snippet: string; date?: string }> };
  return (data.organic ?? []).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
    published_date: r.date,
    source: "serper",
  }));
}

/** SerpAPI */
async function searchSerpApi(req: SearchRequest, adapter: ProviderAdapter, apiKey: ApiKey): Promise<SearchResult[]> {
  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/search`);
  url.searchParams.set("q", req.query);
  url.searchParams.set("api_key", apiKey.encrypted_key);
  url.searchParams.set("num", String(req.count ?? 10));
  url.searchParams.set("start", String(req.offset ?? 0));
  if (req.freshness) url.searchParams.set("tbs", `qdr:${req.freshness[0]}`);
  if (req.safe_search !== undefined) url.searchParams.set("safe", req.safe_search ? "active" : "off");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`SerpAPI search failed: ${res.status}`);
  
  const data = await res.json() as { organic_results: Array<{ title: string; link: string; snippet: string; date?: string }> };
  return (data.organic_results ?? []).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
    published_date: r.date,
    source: "serpapi",
  }));
}

/** Google Custom Search */
async function searchGoogle(req: SearchRequest, adapter: ProviderAdapter, apiKey: ApiKey): Promise<SearchResult[]> {
  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/customsearch/v1`);
  url.searchParams.set("key", apiKey.encrypted_key);
  url.searchParams.set("cx", (globalThis as any).Deno?.env?.get("GOOGLE_CSE_ID") ?? "");
  url.searchParams.set("q", req.query);
  url.searchParams.set("num", String(Math.min(req.count ?? 10, 10)));
  url.searchParams.set("start", String((req.offset ?? 0) + 1));
  if (req.safe_search !== undefined) url.searchParams.set("safe", req.safe_search ? "active" : "off");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Google search failed: ${res.status}`);
  
  const data = await res.json() as { items: Array<{ title: string; link: string; snippet: string; pagemap?: any }> };
  return (data.items ?? []).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet,
    source: "google",
  }));
}

/** Bing Search */
async function searchBing(req: SearchRequest, adapter: ProviderAdapter, apiKey: ApiKey): Promise<SearchResult[]> {
  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  const url = new URL(`${baseUrl}/v7.0/search`);
  url.searchParams.set("q", req.query);
  url.searchParams.set("count", String(req.count ?? 10));
  url.searchParams.set("offset", String(req.offset ?? 0));
  if (req.freshness) url.searchParams.set("freshness", req.freshness);
  if (req.safe_search !== undefined) url.searchParams.set("safeSearch", req.safe_search ? "Strict" : "Off");

  const res = await fetch(url.toString(), {
    headers: { "Ocp-Apim-Subscription-Key": apiKey.encrypted_key },
  });

  if (!res.ok) throw new Error(`Bing search failed: ${res.status}`);
  
  const data = await res.json() as { webPages: { value: Array<{ name: string; url: string; snippet: string; dateLastCrawled?: string }> } };
  return (data.webPages?.value ?? []).map(r => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
    published_date: r.dateLastCrawled,
    source: "bing",
  }));
}

/** Tavily AI Search */
async function searchTavily(req: SearchRequest, adapter: ProviderAdapter, apiKey: ApiKey): Promise<SearchResult[]> {
  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey.encrypted_key}` },
    body: JSON.stringify({
      query: req.query,
      search_depth: "basic",
      max_results: req.count ?? 10,
      include_domains: req.site ? [req.site] : undefined,
    }),
  });

  if (!res.ok) throw new Error(`Tavily search failed: ${res.status}`);
  
  const data = await res.json() as { results: Array<{ title: string; url: string; content: string; score: number }> };
  return (data.results ?? []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.content,
    score: r.score,
    source: "tavily",
  }));
}

/** Exa Neural Search */
async function searchExa(req: SearchRequest, adapter: ProviderAdapter, apiKey: ApiKey): Promise<SearchResult[]> {
  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  const res = await fetch(`${baseUrl}/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey.encrypted_key },
    body: JSON.stringify({
      query: req.query,
      num_results: req.count ?? 10,
      type: "neural",
      use_autoprompt: true,
    }),
  });

  if (!res.ok) throw new Error(`Exa search failed: ${res.status}`);
  
  const data = await res.json() as { results: Array<{ title: string; url: string; text: string; score: number }> };
  return (data.results ?? []).map(r => ({
    title: r.title,
    url: r.url,
    snippet: r.text,
    score: r.score,
    source: "exa",
  }));
}

/** DuckDuckGo (HTML scraping fallback) */
async function searchDuckDuckGo(req: SearchRequest): Promise<SearchResult[]> {
  const url = new URL("https://html.duckduckgo.com/html/");
  url.searchParams.set("q", req.query);
  
  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; OpenLLM/1.0)" },
  });

  if (!res.ok) throw new Error(`DuckDuckGo search failed: ${res.status}`);
  
  const html = await res.text();
  // Simple HTML parsing for results
  const results: SearchResult[] = [];
  const regex = /<a class="result__snippet" href="([^"]+)">([^<]+)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) && results.length < (req.count ?? 10)) {
    results.push({
      title: match[2],
      url: match[1],
      snippet: "",
      source: "duckduckgo",
    });
  }
  return results;
}

/** List available search engines */
export function listSearchEngines(): SearchEngineInfo[] {
  return Object.values(SEARCH_ENGINES);
}

/** Get search engine info */
export function getSearchEngine(engine: SearchEngine): SearchEngineInfo | undefined {
  return SEARCH_ENGINES[engine];
}

/** Get engines by capability */
export function getEnginesByCapability(capability: keyof SearchEngineInfo["capabilities"]): SearchEngineInfo[] {
  return Object.values(SEARCH_ENGINES).filter(e => e.capabilities[capability]);
}

/** Estimate search cost */
export function estimateSearchCost(engine: SearchEngine, queries: number = 1): { cost: number; currency: string } {
  const info = SEARCH_ENGINES[engine];
  if (!info) return { cost: 0, currency: "USD" };
  return { cost: (info.pricing.per_1k_queries / 1000) * queries, currency: info.pricing.currency };
}