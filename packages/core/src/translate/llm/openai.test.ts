import { afterEach, describe, expect, it, vi } from 'vitest';
import { GTRuntime } from '../../runtime';

const llm = { baseUrl: 'http://localhost:1234/v1/', model: 'local-model' };
function mockCompletion(transform: (text: string) => string) {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async (_url, init) => {
      const request = JSON.parse(init!.body as string);
      const input = JSON.parse(request.messages[1].content);
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                translations: input.texts.map(transform),
              }),
            },
          },
        ],
      });
    });
}

describe.sequential('OpenAI-compatible translations', () => {
  afterEach(() => vi.restoreAllMocks());
  it('translates without GT credentials and keeps array order', async () => {
    const fetch = mockCompletion((text) => text.replace('Hello', 'Bonjour'));
    const gt = new GTRuntime({ llm, sourceLocale: 'en' });
    const results = await gt.translateMany(['Hello', 'Hello again'], 'fr');
    expect(
      results.map((result) => result.success && result.translation)
    ).toEqual(['Bonjour', 'Bonjour again']);
    expect(fetch.mock.calls[0][0]).toBe(
      'http://localhost:1234/v1/chat/completions'
    );
    expect(fetch.mock.calls[0][1]?.headers).not.toHaveProperty('Authorization');
  });
  it('preserves JSX components, variables, branches, and non-content fields', async () => {
    mockCompletion((text) => text.replace('Hello', 'Bonjour'));
    const source = {
      i: 0,
      t: 'a',
      d: { ti: 'Hello', b: { other: 'Hello' } },
      c: ['Hello ', { k: 'name', v: 'v' as const }],
    };
    const result = await new GTRuntime({ llm }).translate(
      { source, metadata: { dataFormat: 'JSX' } },
      'fr'
    );
    expect(result).toMatchObject({
      success: true,
      translation: {
        ...source,
        d: { ti: 'Bonjour', b: { other: 'Bonjour' } },
        c: ['Bonjour ', { k: 'name', v: 'v' }],
      },
    });
  });
  it('preserves ICU arguments, plural branches and pound syntax', async () => {
    mockCompletion((text) => text.replace('items', 'articles'));
    const result = await new GTRuntime({ llm }).translate(
      {
        source: '{count, plural, one {# items for {name}} other {# items}}',
        metadata: { dataFormat: 'ICU' },
      },
      'fr'
    );
    expect(result).toMatchObject({
      success: true,
      translation:
        '{count,plural,one{# articles for {name}} other{# articles}}',
    });
  });
  it('rejects invalid output and HTTP failures without exposing provider bodies', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({
        choices: [{ message: { content: '{"translations":[]}' } }],
      })
    );
    await expect(
      new GTRuntime({ llm }).translate('Hello', 'fr')
    ).rejects.toThrow('translation');
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response('secret provider details', { status: 401 })
    );
    await expect(
      new GTRuntime({ llm }).translate('Hello', 'fr')
    ).rejects.toThrow('401');
  });
  it('does not call the endpoint for empty batches', async () => {
    const fetch = mockCompletion((text) => text);
    expect(await new GTRuntime({ llm }).translateMany([], 'fr')).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('passes endpoint credentials, model, and optional JSON mode', async () => {
    const fetch = mockCompletion((text) => text);
    await new GTRuntime({
      llm: {
        ...llm,
        apiKey: 'private-key',
        jsonMode: true,
        reasoningEffort: 'low',
        headers: { 'X-Test': 'value' },
      },
    }).translate('Hello', 'fr');
    const init = fetch.mock.calls[0][1]!;
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer private-key',
      'X-Test': 'value',
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'local-model',
      reasoning_effort: 'low',
      response_format: { type: 'json_object' },
    });
  });
  it('keeps record keys, empty strings and i18next placeholders', async () => {
    mockCompletion((text) => text.replace('Hello', 'Bonjour'));
    const result = await new GTRuntime({ llm }).translateMany(
      {
        custom: {
          source: 'Hello {{name}}',
          metadata: { dataFormat: 'I18NEXT' },
        },
        empty: '',
      },
      'fr'
    );
    expect(result.custom).toMatchObject({ translation: 'Bonjour {{name}}' });
    expect(result.empty).toMatchObject({ translation: '' });
  });
  it('rejects invalid configuration before sending requests', () => {
    expect(() => new GTRuntime({ llm: { ...llm, model: '' } })).toThrow(
      'model'
    );
    expect(
      () => new GTRuntime({ llm: { ...llm, baseUrl: 'file:///tmp' } })
    ).toThrow('HTTP');
    expect(() => new GTRuntime({ llm: { ...llm, timeoutMs: -1 } })).toThrow(
      'timeoutMs'
    );
  });
  it('times out stalled requests', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError'))
          );
        })
    );
    await expect(
      new GTRuntime({ llm: { ...llm, timeoutMs: 10 } }).translate('Hello', 'fr')
    ).rejects.toThrow('timed out');
  });
  it('rejects truncated completions even when their JSON parses', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json({
        choices: [
          {
            finish_reason: 'length',
            message: { content: '{"translations":["Bonjour"]}' },
          },
        ],
      })
    );
    await expect(
      new GTRuntime({ llm }).translate('Hello', 'fr')
    ).rejects.toThrow('did not finish');
  });
  it('batches entries, bounds concurrency, and preserves output order across out-of-order responses', async () => {
    let active = 0;
    let peak = 0;
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (_url, init) => {
        const input = JSON.parse(
          JSON.parse(init!.body as string).messages[1].content
        );
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) =>
          setTimeout(resolve, input.texts[0] === '0' ? 25 : 5)
        );
        active--;
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  translations: input.texts.map((text: string) => `fr:${text}`),
                }),
              },
            },
          ],
        });
      });
    const completed = vi.fn();
    const results = await new GTRuntime({
      llm: { ...llm, batchSize: 2, concurrency: 2, onBatchComplete: completed },
    }).translateMany(['0', '1', '2', '3', '4'], 'fr');
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(peak).toBe(2);
    expect(completed).toHaveBeenCalledTimes(3);
    expect(
      results.map((result) => result.success && result.translation)
    ).toEqual(['fr:0', 'fr:1', 'fr:2', 'fr:3', 'fr:4']);
  });
  it('splits batches at the input character budget', async () => {
    const fetch = mockCompletion((text) => text);
    await new GTRuntime({ llm: { ...llm, maxBatchChars: 1 } }).translateMany(
      ['Hello', 'World'],
      'fr'
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it('honors caller cancellation and validates batch settings', async () => {
    const fetch = mockCompletion((text) => text);
    await expect(
      new GTRuntime({ llm: { ...llm, signal: AbortSignal.abort() } }).translate(
        'Hello',
        'fr'
      )
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    for (const name of ['batchSize', 'concurrency', 'maxBatchChars']) {
      expect(() => new GTRuntime({ llm: { ...llm, [name]: 0 } })).toThrow(
        'positive integer'
      );
    }
  });
});
