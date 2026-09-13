import { readFile, rm } from 'node:fs/promises';
import {
  readObject,
  writeObject,
  runFingerprint,
  mergeResults,
  localError,
  type Checkpoint,
} from './localTranslationProgress.js';
import { GTRuntime } from 'generaltranslation/runtime';
import type {
  Content,
  LLMConfig,
  TranslateManyEntry,
} from 'generaltranslation/types';
import {
  defaultLLMBatchSize,
  defaultLLMConcurrency,
} from 'generaltranslation/internal';
import type { Settings, TranslateFlags, Updates } from '../../types/index.js';
import { resolveLocaleFiles } from '../../fs/config/parseFilesConfig.js';
import { logger } from '../../console/logger.js';

type LocalOptions = Pick<TranslateFlags, 'force' | 'dryRun'> & {
  resume?: boolean;
  batchSize?: number;
  concurrency?: number;
};
type LocalLLMConfig = LLMConfig & { runTimeoutMs?: number };

export function parseLLMCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0)
    throw localError('Batch size and concurrency must be positive integers');
  return count;
}

export async function loadLLMConfig(
  filepath: string,
  options: { dryRun?: boolean } = {}
): Promise<LocalLLMConfig> {
  const config = JSON.parse(
    await readFile(filepath, 'utf8')
  ) as LocalLLMConfig & {
    apiKeyEnv?: string;
  };
  if (config.apiKeyEnv) {
    const apiKey = process.env[config.apiKeyEnv];
    if (!apiKey && !options.dryRun)
      throw localError(
        `Missing LLM credential environment variable ${config.apiKeyEnv}`
      );
    config.apiKey = apiKey;
  }
  return config;
}

/** Translate extracted content directly and persist the existing hash-keyed GT format. */
export async function translateLocal(
  updates: Updates,
  settings: Settings,
  llm: LocalLLMConfig,
  options: LocalOptions
): Promise<void> {
  llm = {
    ...llm,
    ...(options.batchSize !== undefined
      ? { batchSize: options.batchSize }
      : {}),
    ...(options.concurrency !== undefined
      ? { concurrency: options.concurrency }
      : {}),
  };
  const pattern = settings.files.placeholderPaths.gt;
  if (!pattern?.includes('[locale]'))
    throw localError(
      'Local translation requires files.gt with a [locale] placeholder'
    );
  if (
    llm.runTimeoutMs !== undefined &&
    (!Number.isFinite(llm.runTimeoutMs) || llm.runTimeoutMs <= 0)
  ) {
    throw localError('runTimeoutMs must be a positive finite number');
  }
  const deadline = llm.runTimeoutMs
    ? AbortSignal.timeout(llm.runTimeoutMs)
    : undefined;
  const signal =
    deadline && llm.signal
      ? AbortSignal.any([deadline, llm.signal])
      : (deadline ?? llm.signal);
  const entries: Record<string, TranslateManyEntry> = Object.create(null);
  for (const update of updates) {
    if (!update.metadata.hash)
      throw localError('Extracted translation is missing its source hash');
    entries[update.metadata.hash] = {
      source: update.source,
      metadata: {
        hash: update.metadata.hash,
        context: update.metadata.context,
        maxChars: update.metadata.maxChars,
        dataFormat: update.dataFormat,
      },
    };
  }
  if (options.resume) {
    const checkpoints = await Promise.all(
      settings.locales
        .filter((locale) => locale !== settings.defaultLocale)
        .map((locale) =>
          readObject(
            `${resolveLocaleFiles(settings.files.placeholderPaths, locale).gt}.llm-progress.json`
          )
        )
    );
    if (!checkpoints.some(Boolean))
      throw localError('No matching translation checkpoint to resume');
  }
  for (const locale of settings.locales) {
    if (locale === settings.defaultLocale) continue;
    await translateLocale(
      entries,
      settings,
      locale,
      { ...llm, signal },
      options
    );
  }
}

async function translateLocale(
  entries: Record<string, TranslateManyEntry>,
  settings: Settings,
  locale: string,
  llm: LocalLLMConfig,
  options: LocalOptions
): Promise<void> {
  const filepath = resolveLocaleFiles(
    settings.files.placeholderPaths,
    locale
  ).gt!;
  const checkpointPath = `${filepath}.llm-progress.json`;
  let existing = (await readObject<Record<string, Content>>(filepath)) ?? {};
  const fingerprint = runFingerprint(
    entries,
    settings.defaultLocale,
    locale,
    llm
  );
  const checkpoint = await readObject<Checkpoint>(checkpointPath);
  if (options.resume && !checkpoint) {
    logger.step(`${locale}: no unfinished checkpoint; skipping`);
    return;
  }
  if (
    options.resume &&
    (!checkpoint ||
      checkpoint.fingerprint !== fingerprint ||
      !Array.isArray(checkpoint.pending) ||
      checkpoint.pending.some((hash) => !Object.hasOwn(entries, hash)))
  ) {
    throw localError(
      'No matching translation checkpoint; source, locales, or model may have changed. Start a new sync or use --force'
    );
  }
  const hashes = options.resume
    ? checkpoint!.pending
    : Object.keys(entries).filter(
        (hash) => options.force || !Object.hasOwn(existing, hash)
      );
  let remaining = new Set(hashes);
  const total = hashes.length;
  const started = Date.now();
  logger.step(
    `${locale}: ${total} entries; up to ${llm.batchSize ?? defaultLLMBatchSize} per request, ${llm.concurrency ?? defaultLLMConcurrency} concurrent requests`
  );
  if (options.dryRun) return;
  if (!total) {
    if (options.resume) await rm(checkpointPath, { force: true });
    return;
  }
  await writeObject(checkpointPath, { fingerprint, pending: hashes });
  // Serialize disk writes from concurrent requests to prevent lost updates.
  let saves = Promise.resolve();
  const gt = new GTRuntime({
    sourceLocale: settings.defaultLocale,
    customMapping: settings.customMapping,
    llm: {
      ...llm,
      onBatchComplete(results) {
        saves = saves.then(async () => {
          const next = mergeResults(existing, results);
          await writeObject(filepath, next);
          existing = next;
          remaining = new Set(
            [...remaining].filter((hash) => !Object.hasOwn(results, hash))
          );
          await writeObject(checkpointPath, {
            fingerprint,
            pending: [...remaining],
          });
          logger.step(
            `${locale}: saved ${total - remaining.size}/${total} entries (${Math.round((Date.now() - started) / 1000)}s)`
          );
        });
        return saves;
      },
    },
  });
  const heartbeat = setInterval(() => {
    logger.step(
      `${locale}: ${total - remaining.size}/${total} saved; waiting for in-flight batches (${Math.round((Date.now() - started) / 1000)}s elapsed)`
    );
  }, 10000);
  try {
    await gt.translateMany(
      Object.fromEntries(hashes.map((hash) => [hash, entries[hash]])),
      locale
    );
    await saves;
    await rm(checkpointPath, { force: true });
  } catch (error) {
    logger.step(
      `${locale}: ${total - remaining.size}/${total} saved. Run translate-local --resume to continue the unfinished entries`
    );
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}
