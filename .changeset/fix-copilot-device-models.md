---
"clanka": patch
---

Fix GitHub Copilot sign-in and model selection. Device authorization restarts once with a fresh code when GitHub rejects the code as invalid or expired. Copilot models now come from the account's `/models` catalog: the picker and the ACP model list (when Copilot is the default provider) offer the account's model ids, names and reasoning efforts, and each model runs on the Responses or Chat Completions API the catalog advertises for it. Models the account cannot run fail before inference, naming the available ids. Agent output identifies these models as `copilot`.
