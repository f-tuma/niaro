# Proposal

Tracker: **NIAR-298**

## Why

A person who sent a price list last week, or a company that keeps its procedures in a wiki behind a service, cannot ask the assistant about them later: the file's text reached the model once, in its own chat, and service data is read only when the model happens to call the right action. The owner decided on 2026-11-05 that a derived index over attachments and selected service sources, with citations, is consistent with the rule "no own documents"; a document store with folders and editing is not.

## What Changes

- **Embedding role.** The reserved `embedding` role of the model policy (NIAR-293) becomes active. Catalog models get the kind `embedding`; the role takes only such models, of any provider with an OpenAI-compatible `/embeddings`. Off means no index and no knowledge search.
- **Derived index.** Passages live in a libSQL file next to the identity database, with their embeddings as float32 blobs ranked by libSQL's `vector_distance_cos`. Every passage carries access labels: workspace, kind, the person who sent a file, the service and action of a source. The index can be dropped and rebuilt from its sources at any time.
- **What is indexed.** Files people send in chats, for their sender only (on by default while the role has a model and the document converter reads files). Read actions of shared services that need no input, only when an administrator picks them (off by default, at most 20 per workspace).
- **Re-check.** A search ranks only passages labelled for the asker, then re-checks each hit against their current membership, the file still being theirs and available, the source still picked and their grant on its action, failing closed.
- **Search tool.** The agent gets `knowledge_search` while the workspace has an embedding model. The question is embedded as a budgeted model call; at most 4 searches and 8 passages per search per request; passages are framed as untrusted data.
- **Citations.** The answer receipt (NIAR-296) gets `sources`: each passage the answer was given with its file or source name, re-checked for the person reading. The line shows "Sources n" and opens to the passages, on the web and the phone.
- **Resync.** Files are indexed when the chat reads them; settings saves, imports and the administrator's **Rebuild index** run a pass that skips unchanged documents and drops removed ones. The workspace's Knowledge sheet shows the model, passages, documents, last sync, progress and errors.
- **Budget.** Embedding calls use the inference ledger (each indexed document its own root run, a search inside the chat run) and the provider's daily limit; enforce mode needs a price for the embedding model; free providers' embedding models get the zero price.
- **Configuration bundle.** A workspace `knowledge` section carries whether files are indexed, the passage settings and the sources by service and action name, never the index.

## Non-goals

- A document store: uploading documents outside a chat, folders, editing, sharing files with others.
- Indexing services read under each person's own sign-in, a member's own services or actions that need input.
- Scheduled re-reading of sources; reranking; hybrid keyword search.
- Workspace-wide files visible to everyone.

## Risks

Indexed text is a second copy of file and source content; it is derived, scoped by labels, re-checked on every read and dropped by a rebuild, and a deleted chat's files stop being found at once. Embedding a large source costs money and provider requests; every call is budgeted and a pass stops at the first budget or provider-limit refusal. libSQL's native client adds a dependency to the agent package, which already ships it through Mastra.
