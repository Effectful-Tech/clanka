---
"clanka": patch
---

Restart Copilot device authorization once with a fresh code when GitHub rejects an invalid or expired device code. Use the authenticated Copilot model catalog for model IDs, reasoning efforts and supported API endpoints instead of assuming public-provider names or routing by model-name prefixes. Reject unavailable model IDs before inference and identify Copilot models correctly in agent output.

Keep explicitly policy-enabled models available even when Copilot marks them hidden from its picker, and resolve live reasoning capabilities when switching ACP sessions to Copilot. Add an opt-in credential-free catalog diagnostic for investigating account-specific filtering failures.
