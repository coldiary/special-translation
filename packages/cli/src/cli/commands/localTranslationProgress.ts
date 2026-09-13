import { readFile, mkdir, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type {
  Content,
  LLMConfig,
  TranslationResult,
} from 'generaltranslation/types';
import { createDiagnosticMessage } from 'generaltranslation/internal';

export function localError(whatHappened: string): Error {
  return new Error(
    createDiagnosticMessage({ source: 'gt', severity: 'Error', whatHappened })
  );
}

export async function readObject<T extends object>(
  filepath: string
): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(filepath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw localError('Translation data must be a JSON object');
  return value;
}

export async function writeObject(
  filepath: string,
  data: object
): Promise<void> {
  await mkdir(path.dirname(filepath), { recursive: true });
  const temporary = `${filepath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(data, null, 2) + '\n');
    await rename(temporary, filepath);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function runFingerprint(
  entries: object,
  sourceLocale: string,
  targetLocale: string,
  config: LLMConfig
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        entries,
        sourceLocale,
        targetLocale,
        baseUrl: config.baseUrl,
        model: config.model,
        reasoningEffort: config.reasoningEffort,
      })
    )
    .digest('hex');
}

export type Checkpoint = { fingerprint: string; pending: string[] };

export function mergeResults(
  existing: Record<string, Content>,
  results: Record<string, TranslationResult>
): Record<string, Content> {
  const next = { ...existing };
  for (const [hash, result] of Object.entries(results)) {
    if (!result.success) throw localError('Local translation batch failed');
    next[hash] = result.translation;
  }
  return next;
}
