# Aipet · private Windows x64 release

This edition includes the Claude and ChatGPT companions **without sprite usage counters**. It carries no preferences, activity data, AI accounts or hooks from the build computer.

On the destination Windows x64 computer, extract the release ZIP and run **`Install.cmd`** to install for the current user and create an **Aipet** Start Menu shortcut. The installer does not enable sign-in startup or change AI settings. Review its accompanying `Install.ps1` before running it. Administrator rights are not needed.

For portable use, run **`payload\electron.exe`** in the extracted archive. In an installed copy, run **Aipet** from the Start Menu or **`app\electron.exe`** in its installation directory. Keep the executable's adjacent files and `resources` folder together. The pet's runtime is included; it works offline without Node.js or npm.

Use the tray icon to open **Companion studio**. In **Privacy**, optionally enable **Start at Windows sign-in** to wait quietly in the tray until Claude Code or Codex is detected. Use the tray's **Quit Aipet** to exit.

Version **0.1.2** uses the included runtime for thinking, reading, coding and completion signals as well as the pet. No separate Node.js installation is needed. Use **Connections → Connect Codex** to register its ten hooks on this computer. The button backs up an existing user `hooks.json` beside it, honors `CODEX_HOME`, preserves unrelated settings and hooks, and updates recognized older Aipet definitions. Repeated unchanged connections make no write; invalid or unsafe configuration is refused. Then review and trust new or changed definitions in Codex. Claude Code remains a manual merge of the JSON in **Connections → Review setup**. Do not copy raw templates. Installation and startup never register hooks.

To upgrade 0.1.0 or 0.1.1, disable **Start at Windows sign-in**, quit Aipet, uninstall the previous registered copy and install 0.1.2. Your separate profile and AI settings remain. Click **Connect Codex** afterward and review/trust any changed definitions in Codex; inspect customized handlers that remain untouched.

The extracted archive includes **Diagnose-Codex.ps1**. Run it from PowerShell with `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Diagnose-Codex.ps1` for a read-only metadata report. Adding `-Probe` explicitly sends one synthetic thinking event through Aipet's own bridge; it does not run a task in Codex. The report contains no commands, full paths or conversation contents. See the guide for custom installation paths and upgrading an existing copy.

Read the [Windows installation and connection guide](docs/release-windows.md) and the [artwork credits and licenses](THIRD_PARTY_NOTICES.md) in this application's `resources\app` folder. This is a private, personal, noncommercial fan application; preserve all attribution, adaptation notices and original artwork licenses.
