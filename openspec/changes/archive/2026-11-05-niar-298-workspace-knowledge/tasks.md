# Tasks

## 1. Embedding role

- [x] 1.1 Model kind `embedding`; the `embedding` role takes only such models, `resolveEmbedding`, Models page and model editor (Model roles, Embedding models).
- [x] 1.2 `embeddings.ts`: OpenAI-compatible `/embeddings` client with batching and response checks (Embedding models).
- [x] 1.3 Ledger kind `embedding`, embedding in budgeted roles and free prices (Budgeted callers, Prices for routed models, Free providers' models).

## 2. Index

- [x] 2.1 `knowledge-index.ts`: libSQL file with labelled passages and `vector_distance_cos` search (Derived knowledge index, Access labels).
- [x] 2.2 `knowledge.ts`: settings and status store, chunking, passes per workspace, skip unchanged, drop removed (What is indexed, Index passes).
- [x] 2.3 Attachment store lists and checks files; the chat hands converted file text to knowledge (What is indexed).

## 3. Search and citations

- [x] 3.1 Label-filtered search with a re-check of every hit (Hits re-checked before use).
- [x] 3.2 `knowledge_search` tool, limits, data framing, ids in the turn (Knowledge search tool).
- [x] 3.3 Receipt `sources`, the Sources section on the web and the phone (Answer receipt contents, Answer receipt line).

## 4. Administration and bundle

- [x] 4.1 Console API and the Knowledge sheet with status, sources, passage settings and Rebuild index (Knowledge settings sheet).
- [x] 4.2 Workspace `knowledge` bundle section (Configuration bundle export, Knowledge in the configuration bundle).

## 5. Verification

- [x] 5.1 Node tests: `knowledge`, `knowledge-http`, `mastra-domain`, `model-policy`, `config-bundle`.
- [x] 5.2 Jest: Knowledge sheet, receipt Sources on the web and the phone.
