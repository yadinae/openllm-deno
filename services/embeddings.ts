/**
 * Embeddings Service — Vector generation for P-CORE-009.
 * Phase C Week 13-14: Embeddings / Media / Search core capabilities.
 *
 * Supports multiple providers: OpenAI, Cohere, Voyage, BGE, etc.
 * Falls back to OpenAI-compatible /embeddings endpoint.
 */

import { providerRegistry, initializeRegistry } from "../providers/index.ts";
import type { ProviderAdapter, ApiKey } from "../providers/types.ts";

initializeRegistry();

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | "base64";
  dimensions?: number;
  user?: string;
}

export interface EmbeddingResponse {
  object: "list";
  data: Array<{
    object: "embedding";
    index: number;
    embedding: number[];
  }>;
  model: string;
  usage: {
    prompt_tokens: number;
    total_tokens: number;
  };
}

export interface EmbeddingModelInfo {
  id: string;
  name: string;
  dimensions: number;
  max_input_tokens: number;
  provider: string;
  pricing: { input_per_1k: number; currency: string };
}

const EMBEDDING_MODELS: Record<string, EmbeddingModelInfo> = {
  "openai/text-embedding-3-small": {
    id: "openai/text-embedding-3-small",
    name: "text-embedding-3-small",
    dimensions: 1536,
    max_input_tokens: 8192,
    provider: "openai",
    pricing: { input_per_1k: 0.00002, currency: "USD" },
  },
  "openai/text-embedding-3-large": {
    id: "openai/text-embedding-3-large",
    name: "text-embedding-3-large",
    dimensions: 3072,
    max_input_tokens: 8192,
    provider: "openai",
    pricing: { input_per_1k: 0.00013, currency: "USD" },
  },
  "openai/text-embedding-ada-002": {
    id: "openai/text-embedding-ada-002",
    name: "text-embedding-ada-002",
    dimensions: 1536,
    max_input_tokens: 8192,
    provider: "openai",
    pricing: { input_per_1k: 0.0001, currency: "USD" },
  },
  "cohere/embed-english-v3.0": {
    id: "cohere/embed-english-v3.0",
    name: "embed-english-v3.0",
    dimensions: 1024,
    max_input_tokens: 512,
    provider: "cohere",
    pricing: { input_per_1k: 0.0001, currency: "USD" },
  },
  "cohere/embed-multilingual-v3.0": {
    id: "cohere/embed-multilingual-v3.0",
    name: "embed-multilingual-v3.0",
    dimensions: 1024,
    max_input_tokens: 512,
    provider: "cohere",
    pricing: { input_per_1k: 0.0001, currency: "USD" },
  },
  "voyage/voyage-3": {
    id: "voyage/voyage-3",
    name: "voyage-3",
    dimensions: 1024,
    max_input_tokens: 32000,
    provider: "voyage",
    pricing: { input_per_1k: 0.0001, currency: "USD" },
  },
  "bge/bge-large-en-v1.5": {
    id: "bge/bge-large-en-v1.5",
    name: "bge-large-en-v1.5",
    dimensions: 1024,
    max_input_tokens: 512,
    provider: "huggingface",
    pricing: { input_per_1k: 0, currency: "USD" },
  },
};

/** Get adapter for a provider */
function getEmbeddingAdapter(provider: string): ProviderAdapter | null {
  const entry = providerRegistry.getEntry(provider);
  if (!entry) return null;
  return entry.adapter;
}

/** Create embeddings using provider's /embeddings endpoint */
export async function createEmbeddings(
  req: EmbeddingRequest,
  apiKey: ApiKey
): Promise<EmbeddingResponse> {
  const modelId = req.model;
  const [provider] = modelId.split("/");
  
  const adapter = getEmbeddingAdapter(provider);
  if (!adapter) {
    throw new Error(`Provider ${provider} not found for embeddings`);
  }

  // Use provider's chat endpoint with embeddings format, or direct HTTP
  // Most OpenAI-compatible providers support /embeddings
  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  const url = `${baseUrl}/embeddings`;

  const payload = {
    model: modelId.replace(`${provider}/`, ""),
    input: req.input,
    encoding_format: req.encoding_format ?? "float",
    dimensions: req.dimensions,
    user: req.user,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey.encrypted_key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Embeddings failed (${res.status}): ${text}`);
  }

  return await res.json() as EmbeddingResponse;
}

/** List available embedding models */
export function listEmbeddingModels(): EmbeddingModelInfo[] {
  return Object.values(EMBEDDING_MODELS);
}

/** Get embedding model info */
export function getEmbeddingModel(modelId: string): EmbeddingModelInfo | undefined {
  return EMBEDDING_MODELS[modelId];
}

/** Estimate tokens for embedding input */
export function estimateEmbeddingTokens(input: string | string[]): number {
  const text = Array.isArray(input) ? input.join(" ") : input;
  // Rough estimate: ~4 chars per token for English
  return Math.ceil(text.length / 4);
}

/** Batch embeddings for large inputs */
export async function batchEmbeddings(
  req: EmbeddingRequest,
  apiKey: ApiKey,
  batchSize: number = 100
): Promise<EmbeddingResponse> {
  const inputs = Array.isArray(req.input) ? req.input : [req.input];
  const allEmbeddings: number[][] = [];
  let totalTokens = 0;

  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    const batchReq: EmbeddingRequest = { ...req, input: batch };
    const result = await createEmbeddings(batchReq, apiKey);
    allEmbeddings.push(...result.data.map(d => d.embedding));
    totalTokens += result.usage.total_tokens;
  }

  return {
    object: "list",
    data: allEmbeddings.map((embedding, index) => ({
      object: "embedding",
      index,
      embedding,
    })),
    model: req.model,
    usage: {
      prompt_tokens: totalTokens,
      total_tokens: totalTokens,
    },
  };
}