import { z, type ZodSchema } from "zod";
import type {
  OllamaChatRequest,
  OllamaChatResponse,
  OllamaClientConfig,
  OllamaEmbeddingRequest,
  OllamaEmbeddingResponse,
  OllamaGenerateRequest,
  OllamaGenerateResponse,
  OllamaHealthStatus,
  OllamaMessage,
  OllamaOptions,
} from "./types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_BASE_URL =
  process.env["OLLAMA_BASE_URL"] ?? "http://localhost:11434";
const DEFAULT_MODEL = process.env["OLLAMA_MODEL"] ?? "qwen2.5-coder:14b";
const DEFAULT_TIMEOUT_MS = 120_000;
const HEALTH_TIMEOUT_MS = 5_000;
const MAX_RETRY_ATTEMPTS = 3;

/** Options forced on every outbound request — disables chain-of-thought tokens. */
const FORCED_OPTIONS: Readonly<OllamaOptions> = { think: false };

// ─── Retry helpers ────────────────────────────────────────────────────────────

function isRetryable(err: unknown): boolean {
  if (err instanceof OllamaNetworkError) return true;
  if (err instanceof OllamaHttpError) return err.status >= 500;
  return false;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Custom error types ───────────────────────────────────────────────────────

export class OllamaNetworkError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "OllamaNetworkError";
  }
}

export class OllamaHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string
  ) {
    super(`Ollama HTTP ${status}: ${body}`);
    this.name = "OllamaHttpError";
  }
}

export class OllamaParseError extends Error {
  constructor(
    message: string,
    readonly raw: string
  ) {
    super(message);
    this.name = "OllamaParseError";
  }
}

export class OllamaSchemaError extends Error {
  constructor(
    message: string,
    readonly issues: z.ZodIssue[]
  ) {
    super(message);
    this.name = "OllamaSchemaError";
  }
}

// ─── OllamaClient ─────────────────────────────────────────────────────────────

/**
 * HTTP client for the Ollama REST API.
 *
 * All public methods enforce `think: false` in the options payload so that
 * chain-of-thought tokens are never included in responses.
 *
 * Network errors and 5xx responses are retried with exponential back-off
 * (up to {@link MAX_RETRY_ATTEMPTS} attempts). 4xx errors are not retried.
 */
export class OllamaClient {
  readonly #config: OllamaClientConfig;

  constructor(config: Partial<OllamaClientConfig> = {}) {
    this.#config = {
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      defaultModel: config.defaultModel ?? DEFAULT_MODEL,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Multi-turn chat completion via POST /api/chat.
   *
   * `think: false` is merged into options before sending.
   * Returns only when the model signals `done: true`.
   *
   * @param messages - Conversation history (system, user, assistant roles).
   * @param options  - Optional model hyper-parameters (merged with forced options).
   */
  async chat(
    messages: OllamaMessage[],
    options?: OllamaOptions
  ): Promise<OllamaChatResponse> {
    const body: OllamaChatRequest = {
      model: this.#config.defaultModel,
      messages,
      stream: false,
      options: this.#mergeOptions(options),
    };

    const raw = await this.#fetchWithRetry("/api/chat", body);
    return raw as OllamaChatResponse;
  }

  /**
   * Single-prompt generation via POST /api/generate.
   *
   * `think: false` is merged into options before sending.
   * Returns the full text in `response` when `done: true`.
   *
   * @param prompt  - The raw prompt string.
   * @param options - Optional model hyper-parameters.
   */
  async generate(
    prompt: string,
    options?: OllamaOptions
  ): Promise<OllamaGenerateResponse> {
    const body: OllamaGenerateRequest = {
      model: this.#config.defaultModel,
      prompt,
      stream: false,
      options: this.#mergeOptions(options),
    };

    const raw = await this.#fetchWithRetry("/api/generate", body);
    return raw as OllamaGenerateResponse;
  }

  /**
   * Text embeddings via POST /api/embeddings.
   *
   * @param request - Model name and text(s) to embed.
   */
  async embeddings(
    request: OllamaEmbeddingRequest
  ): Promise<OllamaEmbeddingResponse> {
    const raw = await this.#fetchWithRetry("/api/embeddings", request);
    return raw as OllamaEmbeddingResponse;
  }

  /**
   * Health check via GET /api/tags with a hard 5-second timeout.
   *
   * @returns Structured status including daemon availability and model list.
   */
  async healthCheck(): Promise<OllamaHealthStatus> {
    const url = `${this.#config.baseUrl}/api/tags`;
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
      });
      if (!res.ok) {
        return {
          available: false,
          models: [],
          error: `HTTP ${res.status}: ${await res.text()}`,
        };
      }
      const data = (await res.json()) as { models?: { name: string }[] };
      const models = (data.models ?? []).map((m) => m.name);
      return { available: true, models };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Unknown health check error";
      return { available: false, models: [], error: message };
    }
  }

  /**
   * Returns true if the given model name is listed by the Ollama daemon.
   *
   * The check is prefix-aware: `qwen2.5-coder:14b` matches `qwen2.5-coder:14b`
   * as well as a variant stored without a tag like `qwen2.5-coder`.
   *
   * @param model - Full model name, e.g. `qwen2.5-coder:14b`.
   */
  async isModelAvailable(model: string): Promise<boolean> {
    const { available, models } = await this.healthCheck();
    if (!available) return false;
    const base = model.split(":")[0]!;
    return models.some((m) => m === model || m === base || m.startsWith(base));
  }

  /**
   * Generates a response and parses it against a Zod schema.
   *
   * If JSON parsing or schema validation fails, a "repair" prompt is sent
   * (up to `maxRepairs` times) asking the model to re-emit valid JSON.
   *
   * - JSON parse failures  → repair prompt (reuse same conversation context)
   * - Schema mismatches    → repair prompt with schema description
   * - Both exhausted       → throws the last error
   *
   * @param prompt     - The original generation prompt.
   * @param schema     - Zod schema the response must satisfy.
   * @param maxRepairs - Maximum repair attempts (default 2).
   */
  async callWithOutputRecovery<T>(
    prompt: string,
    schema: ZodSchema<T>,
    maxRepairs = 2
  ): Promise<T> {
    let lastError: Error | undefined;
    let currentPrompt = prompt;

    for (let attempt = 0; attempt <= maxRepairs; attempt++) {
      const res = await this.generate(currentPrompt);
      const raw = res.response.trim();

      // Attempt JSON parse
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        lastError = new OllamaParseError(
          `Attempt ${attempt + 1}: response is not valid JSON`,
          raw
        );
        currentPrompt = this.#buildRepairPrompt(
          prompt,
          raw,
          "invalid JSON — output is not parseable"
        );
        continue;
      }

      // Attempt schema validation
      const result = schema.safeParse(parsed);
      if (result.success) return result.data;

      lastError = new OllamaSchemaError(
        `Attempt ${attempt + 1}: schema validation failed`,
        result.error.issues
      );
      currentPrompt = this.#buildRepairPrompt(
        prompt,
        raw,
        result.error.message
      );
    }

    throw lastError ?? new Error("callWithOutputRecovery: unknown failure");
  }

  /**
   * Compresses long content for use in context-limited prompts.
   *
   * Keeps the first `headLines` lines and the last `tailLines` lines,
   * inserting a `… (N lines omitted) …` separator when content is truncated.
   *
   * @param content   - Multi-line text to compress.
   * @param headLines - Number of leading lines to preserve (default 8).
   * @param tailLines - Number of trailing lines to preserve (default 5).
   */
  microCompact(content: string, headLines = 8, tailLines = 5): string {
    const lines = content.split("\n");
    const total = headLines + tailLines;
    if (lines.length <= total) return content;

    const omitted = lines.length - total;
    const head = lines.slice(0, headLines);
    const tail = lines.slice(lines.length - tailLines);
    return [
      ...head,
      `… (${omitted} line${omitted === 1 ? "" : "s"} omitted) …`,
      ...tail,
    ].join("\n");
  }

  /**
   * Builds a structured table-format prompt for a coding task.
   *
   * Using tabular layout instead of prose reduces token usage and improves
   * model adherence to structured output contracts.
   *
   * @param task - Object describing the coding task parameters.
   */
  buildStructuredPrompt(task: {
    action: string;
    filePath?: string;
    language?: string;
    context?: string;
    instructions: string;
    outputFormat?: string;
  }): string {
    const rows: [string, string][] = [
      ["Action", task.action],
      ...(task.filePath ? ([["File", task.filePath]] as [string, string][]) : []),
      ...(task.language
        ? ([["Language", task.language]] as [string, string][])
        : []),
      ["Instructions", task.instructions],
      ...(task.outputFormat
        ? ([["Output format", task.outputFormat]] as [string, string][])
        : []),
    ];

    const table = rows
      .map(([k, v]) => `| ${k.padEnd(16)} | ${v} |`)
      .join("\n");

    const contextSection = task.context
      ? `\n\n## Context\n\`\`\`\n${this.microCompact(task.context)}\n\`\`\``
      : "";

    return `## Task\n\n| Field             | Value |\n|-------------------|-------|\n${table}${contextSection}`;
  }

  // ─── Accessors ──────────────────────────────────────────────────────────────

  /** The default model name used when no override is supplied at call-site. */
  get defaultModel(): string {
    return this.#config.defaultModel;
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  /**
   * Merges caller-supplied options with the forced defaults.
   * `FORCED_OPTIONS` always wins, so `think: false` cannot be overridden.
   */
  #mergeOptions(options?: OllamaOptions): OllamaOptions {
    return { ...options, ...FORCED_OPTIONS };
  }

  /**
   * POST to an Ollama endpoint with JSON body, timeout, and exponential retry.
   *
   * Retries on network errors and HTTP 5xx (up to MAX_RETRY_ATTEMPTS).
   * Does NOT retry on 4xx or successful non-OK responses with useful body.
   *
   * @param path - API path, e.g. `/api/chat`.
   * @param body - JSON-serialisable request body.
   */
  async #fetchWithRetry(path: string, body: unknown): Promise<unknown> {
    const url = `${this.#config.baseUrl}${path}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        // Exponential back-off: 500ms, 1000ms, …
        await sleep(500 * Math.pow(2, attempt - 1));
      }

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(this.#config.timeoutMs),
        });

        if (!res.ok) {
          const text = await res.text().catch(() => "(unreadable)");
          const err = new OllamaHttpError(res.status, text);
          if (!isRetryable(err)) throw err;
          lastError = err;
          continue;
        }

        return await res.json();
      } catch (err) {
        if (err instanceof OllamaHttpError) {
          // Already handled above (non-retryable 4xx rethrown immediately).
          throw err;
        }
        // Network-level failure (DNS, ECONNREFUSED, AbortError from timeout).
        const wrapped = new OllamaNetworkError(
          `Network error reaching ${url}: ${err instanceof Error ? err.message : String(err)}`,
          err
        );
        lastError = wrapped;
        // If final attempt, fall through to throw below.
      }
    }

    throw lastError ?? new OllamaNetworkError(`Request to ${url} failed`);
  }

  /**
   * Constructs a repair prompt that instructs the model to re-emit its
   * previous response in the required JSON format.
   *
   * @param originalPrompt - The prompt that produced the invalid response.
   * @param badOutput      - The model's invalid response text.
   * @param reason         - Short description of what went wrong.
   */
  #buildRepairPrompt(
    originalPrompt: string,
    badOutput: string,
    reason: string
  ): string {
    return `## Repair Request

| Field             | Value |
|-------------------|-------|
| Problem           | Previous response was ${reason} |
| Original task     | See below |
| Invalid response  | See below |
| Required action   | Re-emit as valid JSON matching the schema |

## Original Task

${originalPrompt}

## Invalid Response (do NOT reproduce, fix it)

\`\`\`
${this.microCompact(badOutput)}
\`\`\`

Respond with ONLY valid JSON. No markdown fences, no prose.`;
  }
}
