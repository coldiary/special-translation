import type { Content } from '@generaltranslation/format/types';
import type { EntryMetadata } from '../../types-dir/api/entry';
import { mapContent } from './content';
import type { LLMConfig } from './config';

export type PreparedEntry = {
  hash: string;
  source: Content;
  metadata?: EntryMetadata;
  texts: string[];
};

export const defaultLLMBatchSize = 20;
export const defaultLLMConcurrency = 3;
export const defaultLLMMaxBatchChars = 12000;

export function prepareBatches(
  requests: Record<string, { source: Content; metadata?: EntryMetadata }>,
  config: LLMConfig
): PreparedEntry[][] {
  const batches: PreparedEntry[][] = [];
  let batch: PreparedEntry[] = [];
  let chars = 0;
  for (const [hash, entry] of Object.entries(requests)) {
    const texts: string[] = [];
    mapContent(entry.source, entry.metadata?.dataFormat ?? 'STRING', (text) => {
      if (text.trim()) texts.push(text);
      return text;
    });
    const prepared = { hash, ...entry, texts };
    const size = JSON.stringify(prepared).length;
    if (
      batch.length &&
      (batch.length >= (config.batchSize ?? defaultLLMBatchSize) ||
        chars + size > (config.maxBatchChars ?? defaultLLMMaxBatchChars))
    ) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(prepared);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
