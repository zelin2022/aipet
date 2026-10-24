# Project boundaries

- Windows x64 desktop app; Claude Code and Codex only; original Claude and GPT characters only.
- Implement all application behavior independently. `.reference/` is a read-only study copy, never an executable dependency. Do not run its code, scripts, hooks, plugins, installers or updater.
- Preserve imported artwork/data/license bytes. `assets/crosspet/provenance.json` pins hashes; run `npm run assets:verify` after asset changes. Keep attribution and rights caveats.
- Do not read AI transcripts, source files, credentials, cookies, AI databases, window titles or command lines to infer activity. Default hook bridge ignores stdin; optional session-aware parsing must remain explicit and bounded.
- No runtime network clients, analytics, remote code, updater or automatic AI config edits. Explicit user requests to connect AI tools permit backed-up, narrowly scoped hook edits while preserving host trust and existing settings. Keep renderers sandboxed, IPC narrow, and all external events untrusted.
- Never log hook payloads. Activity metadata cannot approve tools or run commands. Do not add production npm dependencies without a specific need and review.
- Use `npm test` and `npm run test:desktop` for relevant changes. Build with `npm run package`, then use `npm run test:packaged` to exercise the copied payload. Rebuild after source changes; `dist/` is ignored.
- Do not install hooks in the user's AI tools merely to test the UI. Synthetic events and isolated test inboxes cover development; authenticated host setup remains an explicit user action.
