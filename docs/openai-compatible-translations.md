# Translate with your own LLM endpoint

This fork of [generaltranslation/gt](https://github.com/generaltranslation/gt) retains its components, extraction, hashing, locale handling, and local translation format. It adds an OpenAI-compatible translation backend and `gt translate-local`. No GT account, project ID, API key, upload, or CDN is required for this workflow.

The endpoint must implement non-streaming `POST /chat/completions` with `model` and `messages`, and return text in `choices[0].message.content` ([Chat Completions reference](https://developers.openai.com/api/reference/cli/resources/chat)). Include the API version prefix in `baseUrl`; the library appends `/chat/completions`. The model must follow JSON instructions. `jsonMode` optionally enables `response_format: { type: "json_object" }`; leave it off for endpoints without that feature.

## Build the fork

```sh
pnpm install --frozen-lockfile
pnpm exec turbo run build --filter=gt... --ui stream
```

This builds the CLI and its dependencies. Building **every** upstream package also requires Rust/cargo and the `wasm32-wasip1` target for the Next.js SWC plugin. Package names remain unchanged for compatibility; this checkout has not been published to npm.

## Translate existing React or Next.js components

Keep using GT's existing `<T>`, `<Var>`, `<Plural>`, `<Branch>`, dictionaries, and hooks. Run the fork's CLI from your **application directory**, where `gt-react` or `gt-next` is installed.

Create `gt.config.json`:

```json
{
  "defaultLocale": "en",
  "locales": ["fr", "es"],
  "src": ["src/**/*.{js,jsx,ts,tsx}"],
  "files": {
    "gt": { "output": "src/_gt/[locale].json" }
  }
}
```

Create a separate `llm.config.json`. Use the model identifier served by your endpoint:

```json
{
  "baseUrl": "http://localhost:1234/v1",
  "model": "your-model-id",
  "timeoutMs": 120000
}
```

For an authenticated endpoint, add `"apiKeyEnv": "TRANSLATION_LLM_API_KEY"` and set that environment variable in your shell or CI. The CLI also loads the application's `.env` files. Omit `apiKeyEnv` for an unauthenticated local server. Custom `headers` are supported. Set `reasoningEffort` (for example `"low"`) to send `reasoning_effort` to compatible models. Keep credentials out of committed JSON and browser configuration.

```sh
# Replace /path/to/special-translation with this fork's checkout path.
node /path/to/special-translation/packages/cli/dist/main.js translate-local --dry-run
node /path/to/special-translation/packages/cli/dist/main.js translate-local

# Explicitly regenerate existing translations, for example after changing models:
node /path/to/special-translation/packages/cli/dist/main.js translate-local --force
```

`--batch-size 50` sets the maximum entries per LLM request; `--concurrency 3` sets simultaneous requests. Both override LLM configuration values and require positive integers. `--resume` continues an interrupted run.

`--config` selects the GT project configuration; `--llm-config` selects the endpoint configuration. The command extracts source entries itself: running `gt generate` first is unnecessary. In particular, `generate` can populate target files with source text, which would then count as existing translations. Use `--force` to replace those placeholders.

New or changed source hashes are translated. Existing hash entries, including human edits and empty-string translations, are retained unless `--force` is passed. Every completed batch is merged and saved atomically. If a later batch fails, completed work remains on disk. A `*.llm-progress.json` checkpoint records unfinished hashes; `translate-local --resume` continues that run, including interrupted `--force` runs. Resume refuses changed source/model settings. Add the checkpoint pattern to your project’s `.gitignore`. Invalid existing JSON raises an error rather than being overwritten. Dry runs perform extraction and show missing counts without endpoint requests or file writes.

## Load the files in React

Use GT's local loader, with no endpoint configuration in your browser bundle. For a Vite SPA, for example:

```ts
import { initializeGTSPA } from 'gt-react';

await initializeGTSPA({
  defaultLocale: 'en',
  locales: ['fr', 'es'],
  runtimeUrl: null,
  loadTranslations: async (locale) => {
    const loaders = {
      fr: () => import('./_gt/fr.json'),
      es: () => import('./_gt/es.json'),
    };
    const load = loaders[locale as keyof typeof loaders];
    return load ? (await load()).default : {};
  },
});

// Render after initialization, as in examples/vite-spa.
await import('./main');
```

For Next.js, point `withGTConfig`'s `loadTranslationsPath` to a module exporting a named `loadTranslations(locale)` function that returns the same hash-keyed objects. See `examples/next-ssg/i18n/loadTranslations.ts` and `examples/next-ssg/next.config.ts`. Generate the files before building your application. Keep your existing `<GTProvider>` and components.

## Direct server-side translation

The fork's `GT` and `GTRuntime` constructors accept `llm`. Only translation methods use it; locale/format helpers continue to work as before.

```ts
import { GTRuntime } from 'generaltranslation/runtime';

const gt = new GTRuntime({
  sourceLocale: 'en',
  llm: {
    baseUrl: 'http://localhost:1234/v1',
    model: 'your-model-id',
    apiKey: process.env.TRANSLATION_LLM_API_KEY,
    timeoutMs: 120000,
  },
});

const result = await gt.translate('Hello, world!', 'fr');
const batch = await gt.translateMany(
  [{ source: 'Hello {name}', metadata: { dataFormat: 'ICU' } }],
  'es'
);
```

Use the built fork's `generaltranslation` package for this API. Endpoint keys are separate from GT's legacy `apiKey`. `translateMany` accepts both arrays and hash-keyed records and preserves the corresponding return shape. Network, timeout, and invalid model response errors reject the request. There are no automatic retries or implicit fallbacks to GT. An explicit method timeout overrides `llm.timeoutMs`, which otherwise defaults to the library timeout.

## Behavior and scope

- The model translates text segments with the complete source entry and its context in the prompt. Component IDs, tag names, variables, branch keys, and structure are reconstructed locally. JSX title, placeholder, alt, and aria-label text are translated; aria ID references are preserved.
- ICU messages are parsed and printed using GT's ICU parser. Arguments, formats, selectors, and plural branches are retained. i18next interpolation and basic nesting expressions are preserved.
- This conservative strategy retains source structure and text segment order. It does not reorder components or add target-language plural categories. Review complex sentences spanning elements and languages requiring different plural forms. `maxChars` is supplied to the model as guidance, not a hard truncation rule.
- Requests default to up to 20 entries each (`batchSize`) with 3 in flight (`concurrency`). `maxBatchChars` defaults to 12000 and splits batches sooner when needed; an individual oversized entry is kept intact. These are ordinary Chat Completions requests, not the asynchronous OpenAI Batch API. Truncated, missing, or malformed responses fail validation.
- Progress is printed after every save and every 10 seconds while waiting. `timeoutMs` applies to each request; the CLI also accepts `runTimeoutMs` in its LLM configuration to bound translation time across all locales. In-flight successful batches are drained/saved on ordinary failures; process termination can lose only unsaved batches. Resume continues from the checkpoint without repeating successful batches. A crash between writing the catalog and checkpoint may repeat the last batch.
- `translate-local` covers GT's extracted inline content and dictionaries. Upstream document translation commands (`translate`, `stage`, uploads, PDF/MDX workflows), hosted preview, project management, and CDN services retain their original GT API behavior.
- Framework provider configuration does not accept `llm` directly. Use generated local files for components; use `GTRuntime` in server code for direct translations. Never pass endpoint secrets to client components.

## Verification

```sh
pnpm --filter generaltranslation test
pnpm --filter gt test
pnpm --filter generaltranslation typecheck
pnpm --filter gt typecheck
```

Tests cover unauthenticated endpoints, authentication headers, array/record results, JSX/ICU/i18next structure, invalid responses, timeouts, dry runs, incremental files, and failure preservation. The built CLI has also been exercised against a temporary HTTP mock endpoint, from React extraction through generated JSX JSON and a cached second run. No live model credentials were needed; translation quality against your chosen model remains to be evaluated.
