/**
 * Media Service — Image/Video/Audio generation for P-CORE-009.
 * Phase C Week 13-14: Embeddings / Media / Search core capabilities.
 *
 * Supports: DALL-E, Midjourney, Stable Diffusion, Runway, Pika, Suno, ElevenLabs, etc.
 */

import { providerRegistry, initializeRegistry } from "../providers/index.ts";
import type { ProviderAdapter, ApiKey } from "../providers/types.ts";

initializeRegistry();

export type MediaModality = "image" | "video" | "audio";

export interface MediaGenerationRequest {
  model: string;
  prompt: string;
  negative_prompt?: string;
  width?: number;
  height?: number;
  n?: number;
  size?: string; // e.g., "1024x1024"
  quality?: "standard" | "hd";
  style?: "vivid" | "natural";
  response_format?: "url" | "b64_json";
  // Video specific
  duration?: number; // seconds
  fps?: number;
  // Audio specific
  voice?: string;
  speed?: number;
  // Advanced
  seed?: number;
  guidance_scale?: number;
  num_inference_steps?: number;
}

export interface MediaGenerationResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
}

export interface MediaModelInfo {
  id: string;
  name: string;
  modality: MediaModality;
  provider: string;
  capabilities: {
    text_to_image?: boolean;
    image_to_image?: boolean;
    inpainting?: boolean;
    outpainting?: boolean;
    text_to_video?: boolean;
    image_to_video?: boolean;
    text_to_audio?: boolean;
    voice_cloning?: boolean;
  };
  max_resolution?: string;
  max_duration_seconds?: number;
  supported_sizes?: string[];
  pricing: { per_generation: number; currency: string };
}

const MEDIA_MODELS: Record<string, MediaModelInfo> = {
  // Images
  "openai/dall-e-3": {
    id: "openai/dall-e-3",
    name: "DALL-E 3",
    modality: "image",
    provider: "openai",
    capabilities: {
      text_to_image: true,
      inpainting: false,
      outpainting: false,
    },
    max_resolution: "1792x1024",
    supported_sizes: ["1024x1024", "1792x1024", "1024x1792"],
    pricing: { per_generation: 0.04, currency: "USD" },
  },
  "openai/dall-e-2": {
    id: "openai/dall-e-2",
    name: "DALL-E 2",
    modality: "image",
    provider: "openai",
    capabilities: {
      text_to_image: true,
      inpainting: true,
      outpainting: true,
    },
    max_resolution: "1024x1024",
    supported_sizes: ["256x256", "512x512", "1024x1024"],
    pricing: { per_generation: 0.02, currency: "USD" },
  },
  "stability/stable-diffusion-xl": {
    id: "stability/stable-diffusion-xl",
    name: "Stable Diffusion XL",
    modality: "image",
    provider: "stability",
    capabilities: {
      text_to_image: true,
      image_to_image: true,
      inpainting: true,
      outpainting: true,
    },
    max_resolution: "1024x1024",
    supported_sizes: ["1024x1024", "1152x896", "896x1152", "1216x832", "832x1216"],
    pricing: { per_generation: 0.008, currency: "USD" },
  },
  "midjourney/v6": {
    id: "midjourney/v6",
    name: "Midjourney v6",
    modality: "image",
    provider: "midjourney",
    capabilities: { text_to_image: true },
    max_resolution: "2048x2048",
    pricing: { per_generation: 0.05, currency: "USD" },
  },
  // Videos
  "runway/gen-3-alpha": {
    id: "runway/gen-3-alpha",
    name: "Runway Gen-3 Alpha",
    modality: "video",
    provider: "runway",
    capabilities: { text_to_video: true, image_to_video: true },
    max_duration_seconds: 10,
    pricing: { per_generation: 0.5, currency: "USD" },
  },
  "pika/pika-1.0": {
    id: "pika/pika-1.0",
    name: "Pika 1.0",
    modality: "video",
    provider: "pika",
    capabilities: { text_to_video: true, image_to_video: true },
    max_duration_seconds: 3,
    pricing: { per_generation: 0.3, currency: "USD" },
  },
  "luma/dream-machine": {
    id: "luma/dream-machine",
    name: "Dream Machine",
    modality: "video",
    provider: "luma",
    capabilities: { text_to_video: true, image_to_video: true },
    max_duration_seconds: 5,
    pricing: { per_generation: 0.25, currency: "USD" },
  },
  // Audio
  "elevenlabs/eleven-multilingual-v2": {
    id: "elevenlabs/eleven-multilingual-v2",
    name: "ElevenLabs Multilingual v2",
    modality: "audio",
    provider: "elevenlabs",
    capabilities: { text_to_audio: true, voice_cloning: true },
    pricing: { per_generation: 0.001, currency: "USD" }, // per 1k chars
  },
  "suno/v3": {
    id: "suno/v3",
    name: "Suno v3",
    modality: "audio",
    provider: "suno",
    capabilities: { text_to_audio: true },
    max_duration_seconds: 120,
    pricing: { per_generation: 0.1, currency: "USD" },
  },
  "openai/tts-1": {
    id: "openai/tts-1",
    name: "OpenAI TTS-1",
    modality: "audio",
    provider: "openai",
    capabilities: { text_to_audio: true },
    pricing: { per_generation: 0.015, currency: "USD" }, // per 1k chars
  },
};

/** Get adapter for a provider */
function getMediaAdapter(provider: string): ProviderAdapter | null {
  const entry = providerRegistry.getEntry(provider);
  if (!entry) return null;
  return entry.adapter;
}

/** Generate media (image/video/audio) */
export async function generateMedia(
  req: MediaGenerationRequest,
  apiKey: ApiKey
): Promise<MediaGenerationResponse> {
  const modelId = req.model;
  const [provider] = modelId.split("/");
  
  const adapter = getMediaAdapter(provider);
  if (!adapter) {
    throw new Error(`Provider ${provider} not found for media generation`);
  }

  const baseUrl = adapter.base_url.replace(/\/+$/, "");
  // Determine endpoint based on modality
  const modality = getModality(modelId);
  let endpoint: string;
  
  switch (modality) {
    case "image":
      endpoint = `${baseUrl}/images/generations`;
      break;
    case "video":
      endpoint = `${baseUrl}/videos/generations`;
      break;
    case "audio":
      endpoint = `${baseUrl}/audio/speech`;
      break;
    default:
      throw new Error(`Unknown modality for model ${modelId}`);
  }

  // Build payload based on modality
  const payload = buildMediaPayload(req, modelId, modality);

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey.encrypted_key}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Media generation failed (${res.status}): ${text}`);
  }

  return await res.json() as MediaGenerationResponse;
}

/** Build payload for media generation based on modality */
function buildMediaPayload(req: MediaGenerationRequest, modelId: string, modality: MediaModality): any {
  const modelName = modelId.split("/")[1];
  
  switch (modality) {
    case "image":
      return {
        model: modelName,
        prompt: req.prompt,
        negative_prompt: req.negative_prompt,
        n: req.n ?? 1,
        size: req.size ?? "1024x1024",
        quality: req.quality ?? "standard",
        style: req.style,
        response_format: req.response_format ?? "url",
        seed: req.seed,
        guidance_scale: req.guidance_scale,
        num_inference_steps: req.num_inference_steps,
      };
    case "video":
      return {
        model: modelName,
        prompt: req.prompt,
        negative_prompt: req.negative_prompt,
        duration: req.duration ?? 5,
        fps: req.fps ?? 24,
        width: req.width,
        height: req.height,
        seed: req.seed,
        guidance_scale: req.guidance_scale,
        num_inference_steps: req.num_inference_steps,
      };
    case "audio":
      return {
        model: modelName,
        input: req.prompt,
        voice: req.voice ?? "alloy",
        speed: req.speed ?? 1.0,
        response_format: "mp3",
      };
    default:
      throw new Error(`Unknown modality: ${modality}`);
  }
}

/** Get modality for a model */
function getModality(modelId: string): MediaModality {
  const model = MEDIA_MODELS[modelId];
  return model?.modality ?? "image";
}

/** List available media models */
export function listMediaModels(modality?: MediaModality): MediaModelInfo[] {
  const models = Object.values(MEDIA_MODELS);
  if (!modality) return models;
  return models.filter(m => m.modality === modality);
}

/** Get media model info */
export function getMediaModel(modelId: string): MediaModelInfo | undefined {
  return MEDIA_MODELS[modelId];
}

/** Get supported modalities */
export function getSupportedModalities(): MediaModality[] {
  return ["image", "video", "audio"];
}

/** Estimate cost for media generation */
export function estimateMediaCost(modelId: string, count: number = 1): { cost: number; currency: string } {
  const model = MEDIA_MODELS[modelId];
  if (!model) return { cost: 0, currency: "USD" };
  return { cost: model.pricing.per_generation * count, currency: model.pricing.currency };
}