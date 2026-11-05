# Proposal

Tracker: **NIAR-294**

## Why

Local and custom AI providers were second-class. The provider form assumed OpenRouter, every request sent the key as a bearer token, a server without a key could not serve voice, audio (voice input, meeting transcription, spoken replies) and web search worked only at OpenRouter's canonical address, discovery imported only models that published OpenRouter's capability fields, and a local model had no price, so usage limits in enforce mode refused it. The owner wants local and custom providers first-class: presets, an explicit capability test, and features without OpenRouter, while models and providers stay an administrator's choice.

## What Changes

- **Presets.** The provider form starts from a preset (OpenRouter, OpenAI, Anthropic and Gemini through their OpenAI-compatible endpoints, Azure OpenAI, Ollama, LM Studio, vLLM, llama.cpp server, LocalAI, custom). A preset fills the address, key handling, request format, free choice and a data-handling note; every field stays editable. Presets name no model.
- **Key handling.** A provider sends its key as a bearer token, in a named header (Azure's `api-key`) or not at all. A keyless provider stores no key and counts as connected.
- **Request format (dialect).** `openai` or `openrouter`, chosen by the administrator. OpenRouter's additions (routing privacy flags, JSON audio uploads, audio catalogs, the web plugin, the decisions API) follow the dialect, not the address. Stored providers migrate once.
- **Discovery** works with a plain `GET /models` list; models without published capabilities can be imported and then tested.
- **Capability test.** An administrator starts it per model; it sends one small request per capability of the model's kind (tool calling, image input, audio input and output, transcription, speech), each a model call under the usage budget and the provider's daily limit, and offers the answers as the model's declared capabilities. Image input becomes a declared capability.
- **Free providers.** An explicit administrator choice: their chat, router and decision models get an implied zero price where the workspace has none, so enforce mode admits them. Never inferred from the address; never stored as a price.
- **Audio through standard endpoints** of any provider: multipart `/audio/transcriptions`, `/audio/speech`, and chat completions with audio input or output.
- **Search backends.** The organization keeps SearXNG, Brave or Tavily backends with write-only keys; the model policy chooses one for web search or keeps the provider's own search (the web search role on an OpenRouter-format provider).
- **Data-handling note** per provider, admin-written, optionally prefilled by the preset, shown on the provider.
- **Bundle.** Providers travel with preset, key handling, dialect, free choice and note; search backends travel without keys (`keyRequired`), and the policy names its backend by name.

## Non-goals

- Other vendors' own search tools (OpenAI or Gemini search) as "provider's own search".
- Decision models outside OpenRouter's decisions API.
- Charging search backends' own fees against the usage budget.
- Automatic capability tests or inferring capabilities from model names.

## Risks

- A wrongly marked free provider hides real cost from enforce mode; the switch says so and is off unless a local preset is chosen.
- The capability test spends a few model calls; it runs only when started and goes through the budget and the provider's daily limit.
- OpenAI-compatible servers vary; unknown answers are reported as "could not test" rather than guessed.
