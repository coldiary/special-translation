---
'generaltranslation': minor
'gt': minor
---

Add an OpenAI-compatible translation backend for GT/GTRuntime and a translate-local CLI command that reuses inline extraction and writes local translation files without GT credentials. Preserve JSX structure and ICU variables, validate model output, and retain existing local translations by default.

Batch LLM requests with configurable concurrency, report progress, persist completed batches atomically, and support resuming interrupted translations with an optional run deadline.
