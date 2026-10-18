// Shared types for FreeLLMAPI

export type Platform = 
  | 'agnes' | 'google' | 'groq' | 'openrouter' | 'zhipu' | 'radeon' 
  | 'nvidia' | 'kilo' | 'sail' | 'openai' | 'ovh' | 'ollama' 
  | 'mistral' | 'cloudflare' | 'cohere' | 'custom';

export type KeyStatus = 'healthy' | 'error' | 'rate_limited' | 'invalid';

export interface ApiKeyModel {
  id: number;
  kind: 'chat' | 'embedding' | 'image' | 'audio' | 'transcription' | 'video';
  modelId: string;
  displayName: string;
  family: string | null;
}

export interface ApiKeyCooldown {
  modelId: string;
  expiresAt: string;
}

export interface ApiKey {
  id: number;
  platform: Platform;
  label: string;
  maskedKey: string;
  baseUrl: string | null;
  status: KeyStatus;
  enabled: boolean;
  keyless: boolean;
  keyOptional: boolean;
  exportable: boolean;
  createdAt: string;
  lastCheckedAt: string | null;
  lastHealthError: string | null;
  modelScope: string[] | null;
  monthlyRequestCap: number;
  monthlyTokenCap: number;
  monthlyUsage: {
    requests: number;
    tokens: number;
    resetsAt: string;
  };
  maskedProxyUrl: string;
  models: ApiKeyModel[];
  cooldowns: ApiKeyCooldown[];
  modelDiscovery: boolean;
}
