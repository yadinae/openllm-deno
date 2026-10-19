/**
 * Speech-to-Text (STT) service — /v1/audio/transcriptions
 * Proxies multipart audio upload to STT providers (Whisper-compatible).
 * Ported from FreeLLMAPI services/media.ts runTranscription.
 */

import { decryptKey } from "../db/mod.ts";
import { listApiKeys } from "../db/pg.ts";
import { providerRegistry, initializeRegistry } from "../providers/index.ts";
import type { ProviderAdapter, ApiKey, ProviderCapabilities } from "../providers/types.ts";

initializeRegistry();

export interface TranscriptionRequest {
  file: Uint8Array;
  filename: string;
  mimeType: string;
  model?: string;
  language?: string;
  prompt?: string;
  response_format?: "json" | "text" | "verbose_json" | "vtt";
  temperature?: number;
}

export interface TranscriptionResponse {
  text: string;
  segments?: Array<{
    id: number;
    seek: number;
    start: number;
    end: number;
    text: string;
    tokens: number[];
    temperature: number;
    avg_logprob: number;
    compression_ratio: number;
    no_speech_prob: number;
  }>;
  language?: string;
  duration?: number;
}

async function getSTTCandidates(model?: string): Promise<Array<{ platform: string; adapter: ProviderAdapter; key: ApiKey }>> {
  const allKeys = await listApiKeys();
  const candidates = [];

  for (const key of allKeys) {
    if (!key.enabled || key.status !== "healthy") continue;

    const secret = await decryptKey(key.encrypted_key!, key.iv!, key.auth_tag!).catch(() => null);
    if (!secret) continue;

    const adapter = providerRegistry.get(key.platform);
    if (!adapter) continue;

    // Check if this adapter supports transcription (via capabilities)
    const caps = adapter.capabilities as ProviderCapabilities & { audio?: { transcription?: boolean } };
    if (!caps?.audio?.transcription) continue;

    // If model specified, check platform prefix
    if (model && model.includes("/")) {
      const [platform] = model.split("/");
      if (platform !== key.platform) continue;
    }

    candidates.push({
      platform: key.platform,
      adapter,
      key: {
        id: String(key.db_id),
        platform: key.platform,
        label: key.label ?? key.platform,
        encrypted_key: secret,
        iv: "",
        auth_tag: "",
        status: key.status as "healthy",
        enabled: key.enabled,
        base_url: key.base_url,
        monthly_request_cap: key.monthly_request_cap ?? 0,
        monthly_token_cap: key.monthly_token_cap ?? 0,
        db_id: key.db_id,
      },
    });
  }

  return candidates;
}

async function callProvider(
  adapter: ProviderAdapter,
  apiKey: ApiKey,
  file: Uint8Array,
  filename: string,
  mimeType: string,
  options: Partial<TranscriptionRequest>,
): Promise<TranscriptionResponse> {
  const baseUrl = adapter.base_url.replace(/\/$/, "");
  const url = `${baseUrl}/audio/transcriptions`;

  const formData = new FormData();
  const blob = new Blob([file as unknown as BlobPart], { type: mimeType });
  formData.append("file", blob, filename);
  formData.append("model", options.model ?? "whisper-1");

  if (options.language) formData.append("language", options.language);
  if (options.prompt) formData.append("prompt", options.prompt);
  if (options.response_format) formData.append("response_format", options.response_format);
  if (options.temperature !== undefined) formData.append("temperature", String(options.temperature));

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.encrypted_key}`,
    },
    body: formData,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`STT provider ${adapter.name ?? "unknown"} returned ${res.status}: ${text.slice(0, 300)}`);
  }

  return await res.json() as TranscriptionResponse;
}

export async function runTranscription(
  model: string | undefined,
  req: TranscriptionRequest,
): Promise<TranscriptionResponse> {
  const candidates = await getSTTCandidates(model);
  if (candidates.length === 0) {
    throw new Error("No STT providers available. Add a Whisper-compatible key (e.g., OpenAI, Groq, Together).");
  }

  let lastError: Error | null = null;
  for (const { platform, adapter, key } of candidates) {
    try {
      const result = await callProvider(adapter, key, req.file, req.filename, req.mimeType, req);
      return result;
    } catch (err: any) {
      lastError = err;
    }
  }

  throw new Error(`All STT providers failed${lastError ? ` (last: ${lastError.message.slice(0, 200)})` : " (no usable keys)"}`);
}