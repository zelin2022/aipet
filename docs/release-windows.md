# Aipet for another Windows PC

This private Windows x64 build includes the Claude and ChatGPT companions, their artwork and Aipet's independently implemented interactions. **Sprite usage collection and its studio page are omitted.** It does not import counters, preferences, activity records, AI settings or accounts from the build machine.

## Install and launch

Copy **`Aipet-0.1.0-Windows-x64-no-counters.zip`** to the other Windows x64 computer and extract the complete archive before running anything. Review the included `Install.ps1`, then run **`Install.cmd`**. It installs for the current user at **`%LOCALAPPDATA%\Programs\Aipet`** and creates an **Aipet** Start Menu shortcut. Administrator rights are not needed. Installation does not enable sign-in startup or change AI settings.

The default installer creates no desktop shortcut and does not launch the app. Its optional switches are `-InstallDirectory PATH`, `-DesktopShortcut` and `-Launch`; see the included installation README for invocation examples. `Install.cmd` uses a process-only PowerShell execution-policy override for this reviewed local installer. It does not change saved execution-policy settings, Windows application control, Defender or trust stores.

For portable use, keep the extracted files together and launch **`payload\electron.exe`** directly. In an installed copy, that executable is **`%LOCALAPPDATA%\Programs\Aipet\app\electron.exe`**. Its original vendor filename and executable bytes are retained; Aipet loads from `app\resources\app`. Start Menu shortcuts use Aipet's own icon. Avoid running both installed and portable copies at once because they share this Windows user's Aipet profile.

The desktop app includes its runtime. It needs neither Node.js nor npm to display and interact with the pets, and its normal operation makes no network requests. The optional AI hooks described below use a separate Node.js installation.

Open the companion studio from the tray icon. Under **Privacy**, enable **Start at Windows sign-in** if wanted. This affects only the current Windows user and starts quietly in the tray. **Wait in the tray for AI** wakes the pet when a supported app or a fresh hook signal is detected. **Quit Aipet** in the tray menu exits until the next manual launch or Windows sign-in.

Both **Follow my AI** and **Show both companions** allow Claude and ChatGPT to appear side by side when both supported apps are open. Click to pat a companion, drag her to move the pets, and use **Bring pet home** if their position needs recovering. **Tuck into screen edges** is off by default.

The release has no updater, service or automatic download. Keep Windows security protection enabled. If organizational or device policy rejects the runtime, use the device owner's approved deployment route.

## Connect Claude Desktop Code and Codex

Activity hooks are optional, installed manually on the destination computer. Presence detection alone can notice supported apps; reading, coding, thinking and completion reactions need activity signals. Aipet does not include or copy the build machine's hooks, accounts or trust records, and launching the app does not edit AI settings.

Use native Windows local sessions. This release does not connect WSL, remote, container or cloud runtimes. Use the **Code** tab of Claude Desktop rather than its ordinary chat tab. Codex likewise needs a local coding chat that supports local command hooks.

1. If using the supplied hook examples, install Node.js 22 or newer at its standard Windows path, `C:\Program Files\nodejs\node.exe`. No npm packages or API keys are required. This is a requirement of the hook bridge, not the pet renderer.
2. Keep the release folder in its final location. Open **Companion studio → Connections → Review setup** for each provider. The example shown there uses this installed application's absolute path; do not copy development paths from unrelated examples.
3. Inspect the fixed commands and back up the destination configuration before merging the example's `hooks` entries. Preserve unrelated settings and hooks. For Claude, the user file is `%USERPROFILE%\.claude\settings.json`; for Codex it is `%USERPROFILE%\.codex\hooks.json`. Do not replace an existing entire configuration with an example.
4. Codex requires human review and trust of new or changed hook definitions. Open its hook review (`/hooks` or **Settings → Coding → Hooks → Local**), reload, inspect the Aipet commands and trust the intended entries. Aipet cannot supply that approval. The generic Hook 1/2/3 labels repeat across event groups; inspect their commands.
5. Start a fresh native Windows local session in each app, perform a short normal task and watch Aipet's signal indicator. Host versions and policies determine hook availability. An older chat can retain different hook behavior; a successful test in a new chat does not establish coverage of every existing chat or lane.

Codex's examples retain a readable `command` plus a matching PowerShell `commandWindows` encoded override. The encoding protects fixed executable paths from nested shell quoting; it does not contain conversation contents. Do not change an encoded path independently of its readable command. If Node.js is installed elsewhere, both invocations must be regenerated consistently before trust. Moving Aipet likewise requires fresh examples and host review of changed definitions.

The recommended fixed-state bridge does not read hook stdin. It writes only provider, fixed animation state, a pseudonymous session label, timestamp and schema version under `%USERPROFILE%\.aipet\events`. Claude can separate sessions using its documented session environment variable when supplied by its host. Codex's fixed hooks share one provider state, so concurrent chats can overwrite one another's latest signal. Completion means a response stopped; it does not prove a task succeeded. A **No signal** label does not establish that the AI is idle.

The bridge also contains an advanced session-aware mode, which is not enabled by these fixed examples. That mode parses a bounded hook payload transiently in memory and therefore has a wider privacy boundary. Keep the fixed examples for the smallest input boundary.

## Local data, updates and removal

Preferences and bounded latest-state activity metadata live in **`%USERPROFILE%\.aipet`** on the destination machine. The no-counter release never reads, writes or erases `sprite-usage.json`; an existing file from another Aipet edition remains untouched. There are no conversation logs, credentials, telemetry or remote assets in this package. The application does not inspect AI transcripts, databases, source files, window titles or process command lines to infer work. Its optional presence helper reads allowlisted process names and foreground/fullscreen geometry.

For an update, quit Aipet from its tray menu before replacing the complete application folder. Keep the same final path to preserve shortcut and hook targets. Preferences stay in the separate profile folder. Re-review host hooks if their definitions change.

To remove Aipet, turn off **Start at Windows sign-in**, quit it, then choose Aipet in **Windows Settings → Apps → Installed apps** or run **`Uninstall.cmd`** in the installation directory. The uninstaller removes only recorded files whose hashes still match, its own shortcuts and its own uninstall registration. Modified or additional files remain for review; it preserves the separate profile and all AI configuration. Startup registration is never changed by the installer or uninstaller, which is why it should first be disabled in Aipet.

Remove only the Aipet hook entries you manually added; do not delete unrelated AI configuration. Optionally remove Aipet's profile folder after reviewing any data you want to retain. Moving the app requires updating its startup registration, shortcuts and absolute hook paths. Reinstalling requires first uninstalling the previous registered copy; the installer refuses to overwrite an existing destination or an existing Aipet uninstall registration.

## Artwork credits and use

This is a private, personal, noncommercial fan application. Original artwork and character data come from **CrossPet by lokicorvus and contributors**, pinned to commit `6e98970f6ff9b44e8ac85215241cabcd78f67d92`. The imported files retain their original bytes. Additional Claude poses and the GPT redesign are separately recorded AI-assisted adaptations, with prompts, provenance, attribution and modification notices preserved beside the images.

CrossPet identifies character artwork and designs as **CC BY-NC-SA 4.0**, separately from its MIT code license. Keep the full [third-party notices](../THIRD_PARTY_NOTICES.md), [original character license](../assets/crosspet/characters/LICENSE.md), [upstream repository license](../assets/crosspet/UPSTREAM_LICENSE.txt), and the two custom character attribution documents in the package. Credits include ZipZipPipe for the GPT white-dragon design and the community Claude personification references recorded by CrossPet. CrossPet's grant covers only rights it controls; the retained notices do not establish independent clearance of all community designs or third-party works. Do not treat this personal transfer as permission for public or commercial redistribution. No affiliation or endorsement by the referenced AI or drink brands is implied.
