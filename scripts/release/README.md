# Aipet · private Windows x64 release

This edition includes the Claude and ChatGPT companions **without sprite usage counters**. It carries no preferences, activity data, AI accounts or hooks from the build computer.

On the destination Windows x64 computer, extract the release ZIP and run **`Install.cmd`** to install for the current user and create an **Aipet** Start Menu shortcut. The installer does not enable sign-in startup or change AI settings. Review its accompanying `Install.ps1` before running it. Administrator rights are not needed.

For portable use, run **`payload\electron.exe`** in the extracted archive. In an installed copy, run **Aipet** from the Start Menu or **`app\electron.exe`** in its installation directory. Keep the executable's adjacent files and `resources` folder together. The pet's runtime is included; it works offline without Node.js or npm.

Use the tray icon to open **Companion studio**. In **Privacy**, optionally enable **Start at Windows sign-in** to wait quietly in the tray until Claude Code or Codex is detected. Use the tray's **Quit Aipet** to exit.

For thinking, reading, coding and completion reactions, manually set up the destination computer's AI hooks using **Connections → Review setup**. These optional hooks require a separate Node.js installation and the host's normal human review/trust. Installation never changes AI settings automatically.

Read the [Windows installation and connection guide](docs/release-windows.md) and the [artwork credits and licenses](THIRD_PARTY_NOTICES.md) in this application's `resources\app` folder. This is a private, personal, noncommercial fan application; preserve all attribution, adaptation notices and original artwork licenses.
