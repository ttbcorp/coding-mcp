/**
 * Types for Ollama REST API requests and responses.
 * Covers /api/chat, /api/generate, /api/tags, and /api/embeddings endpoints.
 */

// ─── Core message type ────────────────────────────────────────────────────────

export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── Model options (shared across chat / generate) ───────────────────────────

export interface OllamaOptions {
  temperature?: number;
  top_p?: number;
  num_predict?: number;
  /** Disable chain-of-thought "thinking" tokens (Qwen3 / DeepSeek R-series). */
  think?: boolean;
  stop?: string[];
  repeat_penalty?: number;
}

/** @deprecated Renamed to OllamaOptions for clarity. Left for backwards compat. */
export type OllamaModelOptions = OllamaOptions;

// ─── Chat endpoint (/api/chat) ───────────────────────────────────────────────

export interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  stream?: boolean;
  options?: OllamaOptions;
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

// ─── Generate endpoint (/api/generate) ───────────────────────────────────────

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  stream?: boolean;
  options?: OllamaOptions;
}

export interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

// ─── Embeddings endpoint (/api/embeddings) ───────────────────────────────────

export interface OllamaEmbeddingRequest {
  model: string;
  input: string | string[];
}

export interface OllamaEmbeddingResponse {
  model: string;
  embeddings: number[][];
}

// ─── Streaming ───────────────────────────────────────────────────────────────

export interface OllamaStreamChunk {
  model: string;
  /** Non-empty for /api/generate streaming chunks. */
  response?: string;
  /** Non-empty for /api/chat streaming chunks. */
  message?: OllamaMessage;
  done: boolean;
}

// ─── Health / model listing (/api/tags) ──────────────────────────────────────

export interface OllamaModelInfo {
  name: string;
  modified_at: string;
  size: number;
  digest: string;
}

export interface OllamaTagsResponse {
  models: OllamaModelInfo[];
}

export interface OllamaHealthStatus {
  /** True if the Ollama daemon responded within timeout. */
  available: boolean;
  /** List of model names currently pulled on the daemon. */
  models: string[];
  /** Human-readable error if available is false. */
  error?: string;
}

// ─── Client configuration ────────────────────────────────────────────────────

export interface OllamaClientConfig {
  baseUrl: string;
  defaultModel: string;
  timeoutMs: number;
}
