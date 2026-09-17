---
"clanka": minor
---

Add image vision to ACP prompts and `readFile`.

- ACP always advertises `promptCapabilities.image`. `session/prompt` accepts `image` blocks, `resource_link` blocks with an image mime type (`https:` fetched, `file:` read only when it resolves inside the session directory, symlinks included), and `resource` blocks with an image `blob`. Images become prompt file parts instead of being flattened to text, and persist with the session.
- `readFile` on a png/jpeg/gif/webp attaches the image to the next model turn and returns `Image attached: <name>` to the script. Line ranges on images are an error; `.svg` is still text. The RPC executor carries images to the Agent.
- Every image goes through the same limits (2000x2000, 5MB base64): in-limit images pass through, larger ones are resized with Photon and re-encoded, still-too-large ones are rejected.
- `AgentModelConfig.supportsImages: false` strips images for models known not to take them; otherwise a provider rejection of image input is retried once without images. A `[image: <name> omitted]` note always marks the omission.
- Compaction never sends image bytes to the summarizer; subagent prompts never carry image bytes.
