import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  translateLocal,
  loadLLMConfig,
  parseLLMCount,
} from '../translateLocal.js';
import type { Settings, Updates } from '../../../types/index.js';

const dirs: string[] = [];
async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), 'gt-local-'));
  dirs.push(dir);
  const settings = {
    defaultLocale: 'en',
    locales: ['en', 'fr'],
    files: { placeholderPaths: { gt: path.join(dir, '[locale].json') } },
  } as Settings;
  return { dir, settings };
}
const llm = { baseUrl: 'http://localhost:1234/v1', model: 'test' };
const updates: Updates = [
  { source: 'Hello', dataFormat: 'STRING', metadata: { hash: 'hello' } },
  {
    source: { i: 1, c: 'World' },
    dataFormat: 'JSX',
    metadata: { hash: 'world' },
  },
];

describe('local translation command', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(
      dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
    );
  });
  it('writes loader-compatible JSX and preserves existing human translations', async () => {
    const { dir, settings } = await setup();
    await writeFile(path.join(dir, 'fr.json'), '{"hello":"Salut"}');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        choices: [{ message: { content: '{"translations":["Monde"]}' } }],
      })
    );
    await translateLocal(updates, settings, llm, {});
    expect(
      JSON.parse(await readFile(path.join(dir, 'fr.json'), 'utf8'))
    ).toEqual({ hello: 'Salut', world: { i: 1, c: 'Monde' } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('dry runs do not call endpoints or write files', async () => {
    const { dir, settings } = await setup();
    const fetch = vi.spyOn(globalThis, 'fetch');
    await translateLocal(updates, settings, llm, { dryRun: true });
    expect(fetch).not.toHaveBeenCalled();
    await expect(readFile(path.join(dir, 'fr.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
  it('leaves files intact when a provider fails', async () => {
    const { dir, settings } = await setup();
    await writeFile(path.join(dir, 'fr.json'), '{"hello":"Salut"}');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('', { status: 503 })
    );
    await expect(translateLocal(updates, settings, llm, {})).rejects.toThrow(
      '503'
    );
    expect(await readFile(path.join(dir, 'fr.json'), 'utf8')).toBe(
      '{"hello":"Salut"}'
    );
  });
  it('loads a named environment credential and rejects a missing one', async () => {
    const { dir } = await setup();
    const filepath = path.join(dir, 'llm.json');
    await writeFile(
      filepath,
      JSON.stringify({ ...llm, apiKeyEnv: 'TEST_LLM_KEY' })
    );
    vi.stubEnv('TEST_LLM_KEY', 'test-key');
    expect((await loadLLMConfig(filepath)).apiKey).toBe('test-key');
    vi.stubEnv('TEST_LLM_KEY', '');
    await expect(loadLLMConfig(filepath)).rejects.toThrow('TEST_LLM_KEY');
  });
  it('checkpoints each batch and resumes a forced run without repeating saved entries', async () => {
    const { dir, settings } = await setup();
    const filepath = path.join(dir, 'fr.json');
    await writeFile(filepath, JSON.stringify({ hello: 'old', world: 'old' }));
    const config = { ...llm, batchSize: 1, concurrency: 1 };
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          choices: [{ message: { content: '{"translations":["Bonjour"]}' } }],
        })
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(
      translateLocal(updates, settings, config, { force: true })
    ).rejects.toThrow('503');
    expect(JSON.parse(await readFile(filepath, 'utf8'))).toEqual({
      hello: 'Bonjour',
      world: 'old',
    });
    expect(
      JSON.parse(await readFile(`${filepath}.llm-progress.json`, 'utf8'))
        .pending
    ).toEqual(['world']);
    fetch.mockResolvedValueOnce(
      Response.json({
        choices: [{ message: { content: '{"translations":["Monde"]}' } }],
      })
    );
    await translateLocal(updates, settings, config, { resume: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(await readFile(filepath, 'utf8'))).toEqual({
      hello: 'Bonjour',
      world: { i: 1, c: 'Monde' },
    });
    await expect(
      readFile(`${filepath}.llm-progress.json`)
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('serializes concurrent saves so no completed batch is lost', async () => {
    const { dir, settings } = await setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const { texts } = JSON.parse(
        JSON.parse(init!.body as string).messages[1].content
      );
      return Response.json({
        choices: [
          { message: { content: JSON.stringify({ translations: texts }) } },
        ],
      });
    });
    await translateLocal(
      updates,
      settings,
      { ...llm, batchSize: 1, concurrency: 2 },
      {}
    );
    expect(
      Object.keys(
        JSON.parse(await readFile(path.join(dir, 'fr.json'), 'utf8'))
      ).sort()
    ).toEqual(['hello', 'world']);
  });
  it('rejects resume without a matching checkpoint', async () => {
    const { settings } = await setup();
    await expect(
      translateLocal(updates, settings, llm, { resume: true })
    ).rejects.toThrow('No matching');
  });
  it('resumes a later locale after an earlier locale has finished', async () => {
    const { dir, settings } = await setup();
    settings.locales = ['en', 'fr', 'es'];
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        Response.json({
          choices: [
            { message: { content: '{"translations":["Bonjour","Monde"]}' } },
          ],
        })
      )
      .mockResolvedValueOnce(new Response('', { status: 503 }));
    await expect(translateLocal(updates, settings, llm, {})).rejects.toThrow(
      '503'
    );
    fetch.mockResolvedValueOnce(
      Response.json({
        choices: [
          { message: { content: '{"translations":["Hola","Mundo"]}' } },
        ],
      })
    );
    await translateLocal(updates, settings, llm, { resume: true });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      JSON.parse(await readFile(path.join(dir, 'es.json'), 'utf8')).hello
    ).toBe('Hola');
  });
  it('enforces a whole-run deadline and leaves a resumable checkpoint', async () => {
    const { dir, settings } = await setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(init!.signal!.reason)
          );
        })
    );
    await expect(
      translateLocal(updates, settings, { ...llm, runTimeoutMs: 20 }, {})
    ).rejects.toThrow();
    expect(
      JSON.parse(
        await readFile(path.join(dir, 'fr.json.llm-progress.json'), 'utf8')
      ).pending
    ).toHaveLength(2);
  });
  it('accepts CLI batch overrides and rejects invalid counts', async () => {
    expect(parseLLMCount('50')).toBe(50);
    for (const invalid of ['0', '-1', '1.5', 'foo'])
      expect(() => parseLLMCount(invalid)).toThrow('positive integers');
    const { settings } = await setup();
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        const { texts } = JSON.parse(
          JSON.parse(init!.body as string).messages[1].content
        );
        return Response.json({
          choices: [
            { message: { content: JSON.stringify({ translations: texts }) } },
          ],
        });
      });
    await translateLocal(
      updates,
      settings,
      { ...llm, batchSize: 20 },
      { batchSize: 1, concurrency: 1 }
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
