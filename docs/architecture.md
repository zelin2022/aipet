# Architecture decisions

Decision date: 2026-10-23. Scope: private Windows x64 desktop use, Claude Code and Codex, original Claude and ChatGPT characters. CrossPet is an artwork/behavior reference, never a runtime dependency.

## Desktop shell

Electron provides transparent windows, tray controls and predictable rendering with the existing JavaScript toolchain. It displays original WebP bytes directly. The cost is a large runtime and substantial baseline memory; actual measurements are in [performance.md](performance.md).

| Option | Strength | Decision |
| --- | --- | --- |
| Electron | Bundled renderer, transparent windows, tray and mature window APIs | Selected; simplest way to validate the complete experience with available tools. |
| Tauri | System webview and scoped native capabilities | Requires Rust and Windows C++ tools; reconsider if memory measurements justify migration. |
| Native Win32/WebView2 | Direct Windows composition and input control | Requires native host, tray and IPC ownership; greater initial platform work. |

See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), [webview versions](https://v2.tauri.app/reference/webview-versions/), and [WebView2 transparency](https://learn.microsoft.com/en-us/microsoft-edge/webview2/reference/win32/icorewebview2controller2).

## Ownership and data flow

```text
Original local artwork ───────────────────────────> sandboxed renderer
                                                          ↑
Preferences + tray <──────── narrow preload ──────> main process
                                                          ↑
Provider presence + fullscreen geometry ─ fixed helper ────┤
Fixed activity labels ────────── own file inboxes ──────────┘
```

The main process owns lifecycle, windows, tray, settings, input routing, provider arbitration and minimized event validation. Renderers own pose transitions and presentation, and receive no raw hook payloads. The preload exposes individual actions with validated main-frame senders and arguments, following Electron’s [context isolation guidance](https://www.electronjs.org/docs/latest/tutorial/context-isolation).

The portable folder preserves the official Electron distribution unchanged, loading our allowlisted files through `resources/app`. Launch/startup specification is computed inside main. Startup writes only current-user `Run\Aipet`, uses a direct executable plus `--background`, and reports Windows approval separately. [Deployment](deployment.md), [startup](startup.md).

## Presence and activity

Presence and identity are independent from activity. The fixed Windows helper checks only `codex`/`claude` process names, maps the foreground basename to an enum, and emits fullscreen monitor geometry. No window titles, arguments, text, memory, screenshots or app databases are read. A generic terminal cannot identify its AI session without a hook. The helper polls every 1.2 seconds, emits only changed metadata, disposes process handles, tolerates races and stops when unnecessary or on exit. Its process-scoped execution-policy flag changes no persistent policy. [Windows foreground API](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getforegroundwindow), [PowerShell CLI](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1).

Automatic mode creates the pet only after presence or a fresh activity signal. When no provider remains, a 15-second grace period leads back to a tray process with no pet renderer. Working process detection limits a hook wake hint to ten seconds; without it, the bounded event lifetime provides a fallback. Manual Hide suppresses wake until explicit resume; Show pins visibility. Preview wakes for eight seconds. Fullscreen hiding temporarily removes the pet on the covered monitor. Quit has no restart watchdog.

Automatic character choice prefers the foreground provider, then recent activity, then running provider identity. Manual character selection pins the character without disabling presence needed for dormancy. Busy sessions take precedence over settled sessions of the selected provider. Stale activity returns to idle; completion/error poses have a short hold. `offline` releases a hook lease without displaying an error. Provider processes do not establish thinking, reading, success or failure.

With automatic character selection and the default Show both companions preference enabled, simultaneous Claude/Codex presence displays Claude on the left and ChatGPT on the right. Each has a provider-specific activity snapshot, idle clock, local interaction, blink and alpha mask. Foreground changes do not reorder them. One transparent window contains both slots, so dragging moves the pair together and hide/fullscreen/tray behavior applies to the group. The window expands/contracts as providers appear/disappear, preserves its bottom-right anchor when resizing, and scales down if the chosen display cannot fit the requested size. Manual character pinning or disabling Show both retains the single-companion experience.

119 upstream images are static pose illustrations. Original files remain unchanged; independent CSS motion, pose transitions, thinking dots, terminal/book effects and particles supply animation. Reduced motion suppresses CSS animation and automatic idle pose changes. The app avoids rebuilding the DOM per frame and destroys the pet renderer while dormant.

## Windows and input

The pet is transparent, frameless, non-resizable and absent from the taskbar. A separate studio owns preferences. Position is clamped to a live monitor’s usable area, repaired after display changes, and recoverable through the tray. Screen geometry is converted between Windows physical pixels and Electron device-independent coordinates.

Transparency alone does not pass clicks through. Renderer alpha sampling calls narrowly validated input-routing IPC; main uses `setIgnoreMouseEvents` with forwarded movement. Pointer dragging uses the actual Windows cursor through Electron, with a deadline and final position clamping. No global keyboard hooks or text capture are installed. The optional application accelerator only toggles visibility. [Transparent windows](https://www.electronjs.org/docs/latest/tutorial/custom-window-styles), [mouse interactions](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions).

## Activity boundary

The independent Node adapter writes atomic snapshots to `%USERPROFILE%\.aipet\events`, avoiding Windows Store LocalAppData virtualization. The app additionally reads exact legacy folders containing only its own Aipet events. It never searches provider data directories for content. Each closed-schema event contains only `version`, `provider`, `state`, pseudonymous `session`, and `at`.

Default hooks pass fixed states and ignore stdin. Provider-side tool-name matchers distinguish known reading, coding and tool use. Claude chats use hashes of the documented session environment identifier when available; fixed Codex hooks and missing Claude identifiers use one anonymous provider slot, sacrificing concurrent-session precision. Optional session-aware mode parses bounded hook JSON transiently; its broader input boundary is disclosed in [integrations.md](integrations.md). No transcript/project path is opened. Hooks return passive empty output and cannot approve AI actions.

Detected providers with no recent activity metadata show a No signal badge instead of implying that the AI is resting. Presence never invents activity. An explicit local status request can compare accepted metadata, polling health and the pet renderer's own state without inspecting either AI application. Poll failures use a fixed diagnostic enum and the automatic timer reschedules after an exception.

Readers enforce canonical names, regular files, schema, size, timestamp, count and expiry. A fixed 1,025-byte read rejects files exceeding 1,024 bytes even during growth. Polls do not overlap. Each inbox retains at most 128 valid snapshots, events expire after 15 minutes, and the in-memory engine retains at most 32 sessions. Another process running as this user can forge decorative events; they never authorize commands. There are no sockets or local servers.

Setup is a separately invoked backed-up merge, never automatic app behavior. Both Claude Desktop Code and native Windows local Codex have real metadata delivery evidence. Codex required the user to trust all ten definitions in the desktop dialog; afterward, the backend reported them trusted and real tool events reached the inbox. This verifies transport, not every possible event mapping. Native local, WSL, container and cloud execution contexts must not be conflated. Future integrations must use documented metadata APIs rather than transcripts, logs, credentials, browser inspection or debugger attachment.

## Validation

Unit tests, isolated real Electron renderer/lifecycle tests, native Windows fixtures, direct portable launch, runtime provenance and artwork checks cover distinct boundaries. Native fixture tests use only our windows and geometry; they do not operate AI UIs. Socket snapshots are observational, not packet capture or firewall enforcement. [Validation](validation.md), [native QA](native-qa.md), [security model](security.md).

Mixed-DPI/elevated application behavior and real login scheduling remain limited by the displays and privileges actually exercised. Accessibility and a lower-memory native shell are possible later improvements; distribution/signing is outside this private project’s present scope.
