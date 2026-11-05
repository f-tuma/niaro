# niar-293-model-roles-and-policy

Models are chosen by an administrator-configurable policy: roles (chat, services, checker, selector, background, designer, web search, voice input, meeting transcription, speech; embedding and vision reserved) map to ordered catalog models or tiers, an organization default is inherited by workspaces that may override any role, fallback moves on only from calls that never reached their provider, and escalation repeats a step rejected by a checker once with stronger models. Runs show which model served each step and why (NIAR-293).
