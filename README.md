# Aipet

A local Windows companion for **Claude Desktop Code and Codex**, with CrossPet’s original **Claude and ChatGPT** characters and separately recorded pose adaptations. The application, interactions, activity bridge and effects are independently implemented. No CrossPet application code, installers, hooks, plugins or updater run in this project.

## Launch and use

Launch **Aipet** from the Start Menu after installing the shortcut, or run `dist/Aipet-win32-x64/electron.exe --background`. Keep the portable folder in place. It contains the unmodified official Electron runtime and this application under `resources/app`; the executable retains its vendor filename.

- Aipet waits in the system tray until Claude or Codex is detected. It releases the pet window when both close, after a short grace period. Generic terminals need an activity hook to identify their AI session.
- With **Follow my AI** and **Show both companions** enabled, opening both apps shows Claude and ChatGPT side by side. Each follows its own app's activity. When one app closes, the other companion remains; closing both returns to the tray after the normal grace period.
- Click a character to pat her; only that companion reacts. Drag either character to move the pair together. Click a name badge or the tray icon to open the companion studio. Right-click a character for her controls, or use the tray for the whole group.
- Idle, thinking, reading, coding and tool poses vary without repeating immediately. Occasional idle actions include humming, stretching, yawning, shy affection, hair play, crossed arms with a look away, winking, smug expressions and a drink: black tea for Claude, a white Monster can bearing a dragon-claw emblem for ChatGPT. After two minutes of visible idle time without local attention or fresh activity, she can pout; interacting resets the timer. Work interrupts idle antics; petting briefly reacts before returning to the latest activity. **Gentler motion** disables automatic pose changes and greetings.
- **Hide** suppresses automatic waking until **Resume automatic wake/sleep**. **Show** keeps her visible. **Quit Aipet** ends the app for this Windows session; startup launches it again at the next sign-in.
- **Ctrl+Alt+P** toggles visibility. **Bring pet home** recovers her onto the primary display. Transparent pixels pass input through. Edge tucking is off by default; enable **Tuck into screen edges** in Privacy to opt in.
- **Follow my AI** chooses the character from foreground identity, recent activity and running providers. **Show both companions** is enabled by default; turn it off for one companion that follows the focused app. Select a character to pin her manually and pause automatic character selection. Focus supplies identity, not activity or task success.
- The studio includes nine animation previews, size, motion, fullscreen hiding, presence detection, startup and integration controls. Static pose illustrations use our own transitions and effects.

The **Start at Windows sign-in** setting registers only this user’s `Run\Aipet` entry with `--background`. It can also be managed through Windows Startup apps. It installs no service or watchdog. [Startup details](docs/startup.md).

## Sprite usage

Open **Companion studio → Sprite usage** to find the least-used images by display count, visible time or time share. Filter Claude or ChatGPT, keep **In rotation** to include selectable poses and blinks, or choose **All bundled artwork** to inspect all 176 images, including inactive originals. Zero-use sprites remain visible. Time share uses each companion's own total; both companions accumulate time separately when shown together.

A display counts one actual loaded-image exposure, not animation frames or state snapshots. Hidden, minimized, screen-locked, suspended and studio preview time are excluded. This measures pet-window exposure, without checking whether another window covers it or whether you are looking at it. If renderer reports stop, elapsed time is capped five seconds after the last valid report.

Only local aggregate identifiers, asset hashes, counts, durations and collection/save timestamps are stored in `%USERPROFILE%\.aipet\sprite-usage.json`, with periodic saves every 30 seconds and a final save on normal quit. Collection starts with this feature; it does not reconstruct past usage from AI data. **Reset sprite counters** begins a new observation period after inline confirmation. Counters do not change pose selection. [Measurement details](docs/assets.md#sprite-usage-counters).

## Activity integrations

The metadata-only hooks were installed on this workstation at the user’s request. **Live activity delivery is verified for both Claude Desktop Code and native Windows local Codex.** Claude has emitted real tool and completion signals. After the user trusted all ten Codex hooks in the desktop app, a fresh backend confirmed all ten enabled and trusted with no errors, and real Codex tool events reached the stable inbox. Individual animation mappings still depend on the host's available events. Trust decisions are never changed by Aipet. See [the integration record](docs/integrations.md).

Hook commands use fixed provider/state arguments and **do not read stdin**. They persist only a provider, animation state, pseudonymous session hash, timestamp and version under `%USERPROFILE%\.aipet\events`. Claude's documented session environment variable separates its chats when available; Codex uses one anonymous provider slot in this mode. They do not read conversations, source code, tool arguments or credentials. No terminal Claude sign-in is required for signed-in Claude Desktop Code.

If an app is detected without recent activity metadata, its badge says **No signal**. This does not mean the AI is idle. Run `npm run status` for an on-demand local report comparing inbox activity, polling health, and each pet's displayed state. It reads only Aipet's own state; it does not open either AI app's conversations.

For a temporary delivery trace, run `npm run debug -- start`, reproduce the problem, then run `npm run debug -- read` and `npm run debug -- stop`. Recording is off by default; an immediate capture lasts 15 minutes. An explicit scheduled window can last up to 30 minutes without a midpoint restart. The bounded local metadata log records hook delivery, inbox acceptance and pet states, with hashed workspace labels for hook events. It records no raw folder paths, session identifiers, conversation text, tool contents or hook payloads. A workspace label does not distinguish parallel lanes in that workspace. [Debugging details](docs/integrations.md#temporary-local-debug-log).

Review [the integration guide](docs/integrations.md) before changing settings. The explicitly invoked setup utility preserves unrelated configuration and backs up an existing file:

```powershell
node integrations/setup.mjs plan
node integrations/setup.mjs install
node integrations/setup.mjs remove
```

Starting Aipet never installs hooks. Codex requires human review through `/hooks`. Claude failure hooks express errors; Codex currently lacks an equivalent documented failure event. Completion means a response stopped, not that the task succeeded. The optional session-aware mode has a broader transient input boundary, explained in the guide.

## Privacy and security

The app has no account integration, telemetry, automatic updater, remote assets, localhost server or intentional outbound service calls. Sandboxed, context-isolated renderers have no Node access; narrow IPC, strict validation, CSP and local-file request allowlists constrain them. These controls do not sandbox the main process or other programs running as your Windows account.

The optional hidden PowerShell helper emits only allowlisted process presence, foreground provider and fullscreen geometry. It reads no titles, terminal text, command lines or process memory. Its execution-policy override is confined to that helper process. Preferences and minimized events live under `%USERPROFILE%\.aipet`. Exact legacy **Aipet-owned** inbox paths are also read to accommodate Windows Store virtualization; app conversation stores and databases are untouched. Valid events expire after 15 minutes and are bounded in count and size. [Security boundaries](docs/security.md).

Measured dormant CPU is low, but Electron still uses hundreds of MiB of working-set memory, plus the Windows helper. Point-in-time socket checks found no connections; this is not a packet-capture guarantee. [Performance measurements](docs/performance.md).

## Develop, verify and package

Windows x64 and Node.js 22 or newer:

```powershell
npm ci --ignore-scripts
node node_modules/electron/install.js
npm start -- --studio
npm test
npm run assets:verify
npm run test:desktop
npm run test:lifecycle
npm run test:companions
npm run test:poses
npm run test:usage
npm run test:single-instance
npm run test:native
npm run package
npm run test:packaged
npm run test:portable
node scripts/shortcut.mjs --install
node scripts/startup.mjs enable
```

Dependency installation downloads the pinned official runtime and needs network access. Normal app operation uses local files. The packaging allowlist excludes reference source, tests and build tools, verifies original artwork and all runtime files, and preserves vendor executable bytes. A previously branded executable was rejected by this computer’s Application Control policy; direct launch with the original runtime succeeds without changing Windows policies. [Deployment](docs/deployment.md) and [validation record](docs/validation.md).

## Install on another personal Windows PC

`npm run release` builds a separate **no-counter edition** and creates `dist/release/Aipet-0.1.0-Windows-x64-no-counters.zip`, a checksum sidecar and a release report. It preserves the normal usage-enabled portable build. Counter modules, collection, IPC and the studio usage page are removed at build time; artwork and attribution remain intact. The archive contains an offline current-user installer and no preferences, logs, AI settings or accounts from this machine. Extract it and run **Install.cmd** on the destination PC. Optional activity hooks require separately installed Node.js and the destination host's manual setup/trust. See [installation instructions](docs/release-windows.md).

Verify with `npm run test:release`, `npm run test:packaged -- --release`, `npm run test:poses -- --release` and `node scripts/installer/smoke.mjs`. The installer test redirects installation, shortcuts, registration and application data to an isolated directory; it does not install into this user's normal locations. This is a personal, noncommercial project.

## Artwork and project scope

119 original WebP images, two character-data JSON files and original notices are preserved byte-for-byte from CrossPet commit `6e98970f6ff9b44e8ac85215241cabcd78f67d92`. [Provenance and hashes](assets/crosspet/provenance.json), [asset documentation](docs/assets.md), and [third-party notices](THIRD_PARTY_NOTICES.md) preserve attribution.

Sixteen additional transparent Claude PNGs live in `assets/custom/claude`: the approved wave, two thinking poses, two petting reactions, an affectionate pose, hair play, two reading poses, two coding poses, two running-tool poses, a crossed-arms look away, a wink and black tea from a tiny cup. They were made with OpenAI's built-in image generation tool; their prompts, reference hashes, adaptation notices and output hashes are kept beside them. Custom art is verified separately and joins the corresponding activity and interaction pose pools. Her existing original proud expression supplies the smug action.

The approved GPT redesign preserves white hair and the white/silver knot ornament, with amethyst horns, lavender shadows and a violet dress for clearer contrast and silhouette. Its complete **38-image base profile** was registered in `assets/custom/gpt/` after seven reviewed generation batches. Three further illustrations add a crossed-arms look away, a smug face and a white Monster can bearing a dragon-claw emblem. The already-winking morning greeting is reused for the wink action. The profile replaces the selected original GPT poses together, including a matching blink. If any required state or file fails validation, GPT retains the complete original set. The social states are optional additions, and Claude's additions remain independent.

The bundled inventory is **176 images: 119 preserved originals and 57 custom PNGs (16 Claude + 41 GPT)**. Each companion has the same base coverage of **37 presentation poses plus one matching blink**, with four additional social action pools. Existing puffed cheeks are reused when she has been idle without attention. Per-image display framing normalizes transparent margins without modifying image pixels. The originals, prompts, provenance and attribution remain preserved separately.

The artwork uses **CC BY-NC-SA 4.0**, with upstream caveats about community designs and the rights controlled by the licensor. CrossPet's separate source license is MIT; it does not replace the artwork terms. Publishing this repository does not establish clearance of underlying third-party rights. This is a personal, noncommercial project.

Only Windows, Claude and ChatGPT characters, Claude Code and Codex are in scope. The reference clone is ignored under `.reference/` and never packaged. Source repository: [zelin2022/aipet](https://github.com/zelin2022/aipet). [Architecture decisions](docs/architecture.md).
