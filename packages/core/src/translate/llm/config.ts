import type { TranslationResult } from '../../types';
import { createDiagnosticMessage } from '../../logging/diagnostics';

/** Server/build-time configuration for an OpenAI-compatible Chat Completions API. */
export type LLMConfig = {
  /** API root, including any version prefix, e.g. http://localhost:1234/v1. */
  baseUrl: string;
  model: string;
  /** Maximum entries per request (default 20). */
  batchSize?: number;
  /** Maximum concurrent requests (default 3). */
  concurrency?: number;
  /** Approximate input character budget per batch (default 12000). */
  maxBatchChars?: number;
  /** Optional caller cancellation, including a whole-run deadline. */
  signal?: AbortSignal;
  /** Awaited after each validated batch; useful for durable checkpoints. */
  onBatchComplete?: (
    results: Record<string, TranslationResult>
  ) => Promise<void> | void;
  apiKey?: string;
  /** Sent as reasoning_effort only when configured. */
  reasoningEffort?:
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max';
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Opt in only when the endpoint supports response_format: json_object. */
  jsonMode?: boolean;
};

export function llmError(whatHappened: string): Error {
  return new Error(
    createDiagnosticMessage({
      source: 'generaltranslation',
      severity: 'Error',
      whatHappened,
    })
  );
}

export function validateLLMConfig(config: LLMConfig): void {
  if (!config || typeof config.model !== 'string' || !config.model.trim()) {
    throw llmError('LLM translation requires a non-empty model');
  }
  for (const name of ['batchSize', 'concurrency', 'maxBatchChars'] as const) {
    const value = config[name];
    if (value !== undefined && (!Number.isSafeInteger(value) || value <= 0)) {
      throw llmError(`LLM ${name} must be a positive integer`);
    }
  }
  let url: URL;
  try {
    url = new URL(config.baseUrl);
  } catch {
    throw llmError('LLM translation requires an absolute HTTP(S) baseUrl');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw llmError(
      'LLM baseUrl must be an HTTP(S) API root without credentials, query parameters, or fragments'
    );
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isFinite(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw llmError('LLM timeoutMs must be a positive finite number');
  }
}
