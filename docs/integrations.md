# Local activity integrations

Aipet follows explicit activity events from your AI tools. It does not inspect your screen, window titles, process command lines, conversations, credentials, or AI application directories. Installing or starting Aipet does not change any Claude or Codex settings. The bridge is new application code; it neither imports nor executes CrossPet hooks.

The primary targets are **Claude Desktop's Code tab and the Codex desktop app in local Windows mode**. A terminal sign-in is not required to use either signed-in desktop app. Presence detection uses process basenames (`codex` and `claude`), and fullscreen suppression uses foreground window/monitor geometry. The helper does not read executable paths, window titles, command lines, or screen text; granular animation comes from the optional hooks below. The standalone Claude CLI is not a dependency of the pet or of Claude Desktop Code.

## Explicit setup and local validation

Starting with **0.1.2**, **Companion studio → Connections → Connect Codex** registers the ten fixed-state Codex hooks without copying JSON. This explicit button action writes only the current user’s `hooks.json`: under `CODEX_HOME` when set, or `%USERPROFILE%\.codex` otherwise. It generates commands for the running installation and creates an exact-byte backup beside an existing file before changing it. The result shows the hook and backup paths. It does not edit `config.toml`, host trust records, or project configuration.

Connection preserves unrelated top-level values, event groups and handlers. Only confidently recognized fixed Aipet handlers in their expected event and matcher groups are candidates for replacement; ambiguous commands and customized policy handlers stay untouched. Existing custom fields and disabled choices are retained. Repeating an unchanged connection makes no write or extra backup. Malformed JSON, duplicate keys, files over 256 KiB, linked paths and nonlocal destinations are refused instead of overwritten. Changed JSON is reserialized with two-space indentation while retaining its UTF-8 BOM and newline style; the backup preserves the original bytes. Backup names begin `hooks.json.aipet-backup-`. Keep backups local; they may contain your existing hook configuration. Install and startup never invoke this action.

After connecting, open Codex’s **Settings → Coding → Hooks → Local** or `/hooks`, reload the list, inspect Aipet’s commands and review/trust the intended definitions. Aipet does not approve them for you or bypass review. Then test a new native Windows local chat and watch for a real signal. A successful registration does not prove that an existing chat is emitting hooks. Claude Code remains manual through **Connections → Review setup**.

During an explicitly authorized local validation, Aipet hook entries were installed in `%USERPROFILE%\.claude\settings.json` and `%USERPROFILE%\.codex\hooks.json`. The Claude file's other settings were preserved and its exact previous bytes were backed up beside it using a timestamped backup filename. The Codex hooks file did not exist; `config.toml` was not changed. No security policies, account settings, or trust decisions were edited.

The separate source-development setup utility is also explicitly invoked, never part of app startup:

```powershell
node .\integrations\setup.mjs plan
node .\integrations\setup.mjs install
node .\integrations\setup.mjs remove
```

An optional `claude` or `codex` argument limits the operation to one provider. Setup stages the changes, preserves unrelated settings and hooks, makes a timestamped backup before changing an existing file, and is idempotent. `remove` removes only entries referring to this installation's adapter and preserves other current settings. Prefer this over restoring an old whole-file backup if settings have changed since installation. Backups remain in the user's profile and are never copied into the repository.

Official Claude documentation confirms that local Desktop Code reads hooks from the shared `~/.claude/settings.json`; Desktop runs its own embedded Code runtime, which can differ from the terminal binary. Its desktop sign-in should not be inferred from terminal authentication diagnostics. See [Desktop shared configuration](https://code.claude.com/docs/en/desktop#shared-configuration) and [Desktop Code runtime versions](https://code.claude.com/docs/en/desktop#claude-code-version-in-the-code-tab).

The native Windows Codex app uses `%USERPROFILE%\.codex` and shares agent configuration with native CLI/IDE clients. The user confirmed native Windows local execution. After the user selected Trust all in the desktop's User config hook dialog and ran a tiny task, a fresh read-only `hooks/list` check reported all ten Aipet handlers enabled and trusted, with zero errors or warnings. Real Codex `tool` metadata arrived in `%USERPROFILE%\.aipet\events`, including an event at `2026-10-23T16:58:48.468Z`. No synthetic event was written for this verification. The desktop-bundled backend and profile CLI are byte-identical, version `0.163.0-alpha.10.2`. See [Windows configuration location](https://learn.chatgpt.com/docs/app/windows#share-config-auth-and-sessions-with-wsl) and [app agent configuration](https://learn.chatgpt.com/docs/developer-settings#agent-configuration).

The user's Claude Desktop Code test produced real `success` and `tool` events. Its Windows Store process redirected the original LocalAppData inbox into `%USERPROFILE%\AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Local\Aipet\events`. This explained why the initial reader did not see them. Windows events now default to the stable user-owned `%USERPROFILE%\.aipet\events`, which avoids LocalAppData virtualization. Installed hook command definitions were not changed. The app also reads only the exact legacy Aipet inboxes under LocalAppData and the known Claude/Codex package families; it never searches app conversations or databases.

Both desktop providers now deliver real activity metadata. This verifies the live transport; it does not mean that every configured lifecycle/tool mapping has been observed or that a completion signal proves task success. Claude Desktop's embedded runtime, sign-in, and other account data were left untouched.

For future Codex troubleshooting, open **Settings → Coding → Hooks**, select **Local**, and use **Reload hooks**. Expand **User config** and inspect the commands. Each event restarts its default Hook 1/2/3 numbering; these generic labels are not duplicate definitions. Pending definitions need human review through **Trust** or the source dialog's **Trust all**. Initially, both fresh diagnostics and the user's screenshot showed all ten awaiting review. Trusting the ten entries in that desktop dialog resolved the missing-event condition without changing commands or bypassing trust. Reload refreshes the listing; it does not restart the backend or prove that every existing task reloads its execution hooks.

The October 24 Windows launcher repair adds a `commandWindows` override to the ten Aipet definitions while retaining each readable command. Installing that repair backs up the previous hook file and preserves unrelated configuration. Codex hashes the complete current definition, so previous trust does not authorize the changed definitions: they require a new human review. The source remains passive while review is pending, and setup never edits Codex's trust records. Passing the local launcher checks does not establish successful delivery from the older problematic chat; verify fresh metadata from that chat after review.

## Recommended setup: fixed states, no input parsing

Installed editions starting with **0.1.1** generate hooks in **Connections → Review setup** that invoke the local `integrations/activity-launch.ps1` helper; **Connect Codex** registers those same definitions in 0.1.2. The helper resolves the shipped, unmodified `electron.exe` relative to its own installation, runs the activity bridge with `ELECTRON_RUN_AS_NODE=1` only in that child, closes stdin, discards child output and bounds its lifetime. These installed hooks need no separate Node.js installation or development-machine path. Their PowerShell execution-policy flag is limited to the hook subprocess and does not change saved policies. Complete fresh host trust review for changed definitions. Installation itself does not register hooks. Source-development runs, examples and the setup utility below retain their explicit Node requirement.

The examples invoke `integrations/activity.mjs` with a provider and a fixed animation state. The AI tool performs tool-name matching. The adapter never reads or parses stdin in this mode. For Claude, it hashes only the documented `CLAUDE_CODE_SESSION_ID` environment variable, when present and at most 256 characters, to separate chats. It reads no other session environment key and never enumerates the environment. Fixed Codex hooks and Claude hooks without that variable use one anonymous session per provider. See [Claude's session environment metadata](https://code.claude.com/docs/en/env-vars). Hook APIs still supply their usual input through an operating-system pipe; Aipet does not request those contents or consume that pipe in the recommended mode.

The source-development examples use the absolute Node installation verified on this machine. Adjust the Node and adapter paths if you move either. Claude uses executable-plus-arguments form, with no shell and no extra quote characters inside its `args` strings. Codex retains a readable `command` and supplies a Windows-specific `commandWindows` override. Both run the identical fixed script: the absolute system PowerShell executable with profiles disabled calls the absolute Node executable and Aipet bridge with a fixed provider/state. The override uses PowerShell's UTF-16LE `EncodedCommand` form so another Windows shell cannot reinterpret nested quotes. Encoding carries only that visible script, never a hook payload or user input. Setup and the studio regenerate it after relocating the trusted application root; do not edit an encoded path independently. The fixed example paths contain no shell substitutions or apostrophes. Use similarly simple, trusted paths. These source scripts need Node.js but no npm packages, API keys, network access, or background service.

1. Open the relevant example and inspect it:
   - [Claude Code example](../integrations/claude-hooks.example.json)
   - [Codex example](../integrations/codex-hooks.example.json)
2. For Codex, prefer **Connect Codex** to register the generated definitions. For Claude or manual Codex setup, merge the displayed example’s `hooks` entries into your chosen configuration. Preserve any existing hook entries and other settings; copying a whole example over an existing file would erase your settings. Raw packaged example files remain templates.
3. Start or restart the AI session, review its hooks, and test a short task. Confirm that normal tool approvals still appear and the pet changes state.

For Claude Code, use user settings at `~/.claude/settings.json` or project-local `.claude/settings.local.json`. Claude documents tool hooks, permission requests, notifications, stopping, and failure events in its [hooks reference](https://code.claude.com/docs/en/hooks).

Current Claude supports direct executable `command` plus `args`. The examples explicitly set `onFailure: "continue"`; a pet hook failure must not block development. This avoids relying on Git Bash being present or on PowerShell shell syntax. These fields require a current Claude version; review [command hook fields](https://code.claude.com/docs/en/hooks#command-hook-fields) if your version rejects them.

For Codex, use `~/.codex/hooks.json` or a trusted project's `.codex/hooks.json`. Current official documentation supports lifecycle hooks, enabled by default. Use `/hooks` to review and trust each new or changed definition. Do not bypass hook trust. Some tool paths, including hosted web search, do not emit tool hooks; cloud orchestration does not support these local command hooks. See [official OpenAI hooks documentation](https://learn.chatgpt.com/docs/hooks).

The Windows examples apply to native Windows execution. A WSL, SSH, container, cloud, or other remote AI host has different paths and usually a different local filesystem. This version does not bridge remote filesystems. Using a Windows Node executable through WSL interop may work in your setup, but is unverified and is not installed automatically.

The Codex launcher adds a PowerShell process per event. Examples remain synchronous to preserve event order. Codex supports `async: true` on command handlers, which can avoid waiting for the launcher, but background hooks may finish in a different order; `SessionEnd` remains synchronous. See [background hooks](https://learn.chatgpt.com/docs/hooks#run-hooks-in-the-background). All ten Windows overrides were tested through CMD with standard and verbatim argument handling, PowerShell, and installed Git Bash using isolated synthetic profiles; no authenticated AI host was invoked. The previous nested `-Command` string printed its script instead of executing it under standard CMD argument escaping, despite exiting successfully. The override repairs that reproduced portability defect; the affected old chat's actual launch path has not been observed. Changed definitions require fresh human trust review under [Codex's hook trust rules](https://learn.chatgpt.com/docs/hooks#review-and-trust-hooks).

## What the pet can express

These are Aipet's mappings, not a claim to know the model's internal reasoning:

| Observed event | Aipet state |
| --- | --- |
| Session starts | Idle |
| Session ends | Offline presence hint; display may return to tray |
| Prompt submitted, tool finishes | Thinking |
| Named read, search, or file-view tool starts | Reading |
| Named edit, write, or patch tool starts | Coding |
| Shell, MCP, or named orchestration tool starts | Running a tool |
| Permission requested; selected Claude notifications | Waiting |
| Response stops | Completion animation |
| Claude failure event | Error |
| Codex turn interrupted | Idle |

Fixed-state matchers cover explicitly listed tool names; a new or renamed tool may leave the previous animation until the next lifecycle event. Shell commands always appear as tool activity: the adapter does not examine a command to guess whether it reads or writes files. MCP tool arguments and results are never inspected. Fixed Codex hooks share a single latest state across chats; one chat finishing can overwrite another chat's working state. Claude's session environment metadata avoids this collision when supplied by the host. An anonymous session ending can clear its provider's hook lease while another session still exists; native provider process detection remains the presence authority. Session separation does not aggregate every background task inside one chat, and a response's Stop event is not proof that background work has finished.

Codex's documented shell hook name is `Bash`, including unified exec. The example also accepts raw and `functions.`-prefixed exec, shell, and patch names as compatibility aliases; these extra names do not imply that every version emits separate hooks for them. See [tool coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage).

The completion animation means a response stopped, not that tests passed or the overall task succeeded. Other hooks can continue a stopped response. Current Codex hooks have no documented failure-only event equivalent to Claude's `PostToolUseFailure` or `StopFailure`; this bridge does not parse tool output to infer errors. Claude failure hooks and their fields are documented in the [Claude reference](https://code.claude.com/docs/en/hooks).

Legacy Codex `notify` currently reports only turn completion and passes JSON as a command argument that can include conversation text. It is deliberately not used here. See [official notification configuration](https://learn.chatgpt.com/docs/config-file/config-advanced#notifications).

## Optional session-aware mode

For hook-payload-based session separation, an advanced user can use this Claude handler in place of a fixed-state handler. Fixed Claude hooks already separate chats when the documented environment variable is available:

```json
{"type":"command","command":"C:/Program Files/nodejs/node.exe","args":["G:/workspace/aipet/integrations/activity.mjs","--source","claude"],"timeout":3,"onFailure":"continue"}
```

For Codex, preserve its existing absolute PowerShell/Node launcher and replace the inner `--provider codex --state STATE --hook` arguments with `--source codex`. This mode reads at most 64 KiB of hook JSON and waits at most 750 ms for input. **The entire accepted JSON payload is parsed transiently in the adapter process. It may include prompts, tool arguments, tool results, or the last assistant message supplied by the AI host.** Only `hook_event_name`, `tool_name`, `notification_type`, and `session_id` influence the result. All other fields are discarded; no transcript path is opened and no input is logged or forwarded.

Session IDs become provider-scoped SHA-256 pseudonyms truncated to 32 hexadecimal characters. This supports session separation; it is not an anonymity guarantee. Missing or oversized IDs use the provider's anonymous session. Unknown events, malformed or oversized input, and write failures produce no event. Both `--source` and `--hook` return empty JSON and exit successfully after handled failures; they never approve a tool, reject a prompt, or add model context. A missing Node executable or script can still cause a host-reported hook error.

## Local protocol and diagnostics

When an app is present but Aipet has no recent activity metadata for it, its badge reads **No signal**. This is an observation about signal coverage, not a conclusion that the AI has stopped working. A live task can be quiet between lifecycle events; in particular, Codex's `write_stdin` polls do not reissue PreToolUse, and a long command's PostToolUse may arrive only at completion. The 15-minute event lifetime can expire during such an operation. See [Codex tool coverage](https://learn.chatgpt.com/docs/hooks#tool-coverage).

Run `npm run status` to request a bounded report from the running Aipet instance. It compares accepted provider metadata, polling times, main activity state and the pet's own rendered state. It writes only `.aipet/status.json` on demand, with no session identifiers or hook payloads. It does not launch a pet or studio when Aipet is stopped. An older build without this protocol reports unavailable until rebuilt and restarted.

If one conversation reacts and another does not, test the execution context before changing hooks: Windows local, WSL, SSH and cloud contexts do not share the same filesystem. Claude Desktop Code shares native local settings, and direct hook edits normally reload through its file watcher; an old chat alone does not prove stale configuration. Codex documentation does not guarantee a hook-specific refresh of existing chats. Do not clear history or interrupt active work to test this. Check `/hooks` inside the affected local session when convenient. Current per-conversation coverage remains unresolved until fresh signals from that conversation are observed.

Only five metadata fields are written to `%USERPROFILE%\.aipet\events\<provider>-<session>.json` on Windows:

```json
{"version":1,"provider":"codex","state":"thinking","session":"0123456789abcdef0123456789abcdef","at":"2026-10-23T12:00:00.000Z"}
```

### Temporary local debug log

```powershell
npm run debug -- start
npm run debug -- status
npm run debug -- read
npm run debug -- stop
```

To arm a single future window, provide UTC ISO timestamps ending in `Z`, with either whole seconds or exactly three fractional digits. This PowerShell example starts five minutes from now and records for twenty minutes:

```powershell
$debugStartUtc = [DateTime]::UtcNow.AddMinutes(5)
$debugEndUtc = $debugStartUtc.AddMinutes(20)
$debugTimeFormat = 'yyyy-MM-ddTHH:mm:ss.fffZ'
npm run debug -- schedule ($debugStartUtc.ToString($debugTimeFormat, [Globalization.CultureInfo]::InvariantCulture)) ($debugEndUtc.ToString($debugTimeFormat, [Globalization.CultureInfo]::InvariantCulture))
```

Convert any local start/end times to UTC before passing them to `schedule`.

Debugging is an explicit local action, never enabled at login by default. An immediate recording lasts at most 15 minutes; an explicitly scheduled window can span at most 30 minutes and start no more than 24 hours ahead. The start/end gates are stored in advance and checked by the bridge and app, so recording needs no external wake-up or midpoint reset. The app must be running to capture main/renderer states. A trace retains at most 512 records or 128 KiB in `%USERPROFILE%\.aipet\debug.jsonl`. Start or arm a recording before the relevant interaction; the ordinary inbox stores only the latest state, so it cannot reconstruct earlier transitions retrospectively. Stop ends recording and leaves the bounded log available for inspection. A new recording starts a new trace.

The logger accepts only allowlisted provider, state and delivery-stage metadata plus timestamps. Stages are `hook-invoked`, `hook-written`, `hook-write-failed`, `inbox-accepted`, `main-state` and `renderer-state`. Hook records include a pseudonym derived from the bridge process's own working directory, allowing different workspaces to be compared without recording raw folder paths or opening project files. This hash is a correlation label, not an anonymity guarantee. It does not identify individual chats or lanes within the same workspace. Event timestamps allow a hook write to be compared with inbox acceptance and the pet's main/renderer pose state. The latter is a validated state enum rather than arbitrary badge text.

The normal fixed-state bridge still ignores stdin. No raw hook JSON, prompts, tool inputs/results, session IDs, credentials, AI transcripts or AI databases are logged. Writers use a short bounded lock and atomic replacement; contention or unavailable storage may drop diagnostic records. This is a best-effort troubleshooting trace, not a complete audit. Expiry stops new recording; it does not promise immediate erasure of the existing trace. Debug failures remain passive and must not fail an AI task.

If the main lane is busy, a quick reply in a second lane verifies only that second interaction. It is not evidence that the main lane emitted a hook, and a second-lane completion does not mean all work has finished. The current default Codex activity slot is shared across its chats/lanes. Avoid clearing history or interrupting real work merely to test delivery.

Allowed providers are `claude` and `codex`. Allowed states are `thinking`, `reading`, `coding`, `tool`, `success`, `error`, `waiting`, `idle`, and `offline`. `offline` releases a hook presence lease; it does not represent a model error. Each session file is replaced atomically; this is a latest-state inbox, not an append-only activity log. The running app removes valid stale events after 15 minutes and retains at most the newest 128 valid session files. When the app is stopped, files remain until its next run or manual removal. Timing metadata can still reveal when AI work occurred. Invalid or unrelated files are left untouched; the bridge itself does not delete old session files.

The inbox inherits Windows user-profile filesystem permissions. POSIX `0600`/`0700` modes in the writer do not create a separate Windows security boundary. Another process running as your account can read or spoof these decorative events. The app must treat events as untrusted metadata and never execute anything they contain. Legacy inbox readers are limited to this application's own event folders; old package-local metadata can remain there until cleared separately.

Test the bridge without invoking either AI application:

```powershell
node .\integrations\activity.mjs --provider claude --state thinking
node .\integrations\activity.mjs --provider codex --state coding
node .\integrations\activity.mjs --provider codex --state success
```

`--inbox` accepts an absolute destination for isolated diagnostics; files written there are not consumed by the running app, which watches its normal inbox. Adapter tests use synthetic data only. A separately invoked native Codex smoke task returned its exact requested response without using tools, but that is not a substitute for validating desktop-emitted events. No desktop conversations, auth stores, or internal databases were inspected.

```powershell
node --test .\integrations\activity.test.mjs
```

To disconnect, remove only the Aipet entries you registered, then restart that AI session. Do not delete unrelated hooks.
