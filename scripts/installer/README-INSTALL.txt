Aipet for Windows x64 - personal edition, without sprite usage counters

This offline package contains the application and its unmodified Electron runtime.
No Node.js installation, administrator rights or runtime downloads are required.

INSTALL
1. Extract the entire ZIP to a local folder. Do not run Install.cmd inside the ZIP.
2. Open Install.cmd. Read any Windows security prompt and inspect these scripts
   if desired. This personal build is unsigned; Windows may show a warning.
3. Open Aipet from the Start menu. It starts in the tray and can exit there.

Default destination: %LOCALAPPDATA%\Programs\Aipet
The installer creates a Start menu shortcut and a current-user Installed Apps
entry. It does not enable startup or edit Claude/Codex hooks. Connect AI tools
explicitly from Aipet on this machine and complete any required host review.
Optional AI activity hooks also need a supported Node.js installation at
C:\Program Files\nodejs\node.exe; install Node.js separately before connecting.
The desktop pet itself does not require a separate Node.js installation.

OPTIONAL POWERSHELL INSTALL
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -DesktopShortcut -Launch
Use -InstallDirectory "D:\Apps\Aipet" to choose an unused application folder.
ExecutionPolicy Bypass applies only to the installer PowerShell process; no
machine or user policy is changed. Managed policies may still prevent execution.

UNINSTALL / REPLACE
Exit Aipet from its tray first. Use Windows Settings > Apps > Installed apps,
or run Uninstall.cmd inside the installed Aipet directory. Uninstall removes
only recorded, unchanged program files, its own shortcuts and registration.
Modified or added files are retained. Your %USERPROFILE%\.aipet data and all
Claude/Codex settings are preserved. Uninstall before installing another build.
If you later enable startup, turn it off in Aipet's Privacy pane before
uninstalling. If you connect AI hooks, manually remove only Aipet's hook entries
from your AI configurations when disconnecting. The installer never edits them.

PRIVACY AND RIGHTS
This edition has no sprite usage collection, storage, IPC or studio usage view.
The archive contains no personal settings, logs, captures, chats or credentials.
It makes no installation-time network requests and has no updater or telemetry.
The app uses bounded local activity metadata; see
payload/resources/app/docs/release-windows.md for details. Original artwork licenses and attribution remain
with the application. See payload/resources/app/THIRD_PARTY_NOTICES.md and the
asset attribution files. This is a private, noncommercial build for personal use;
it does not imply broader rights to redistribute third-party characters/art.

installer-manifest.json pins all payload files for corruption detection. These
local hashes are not a code signature and cannot authenticate a replaced ZIP.
