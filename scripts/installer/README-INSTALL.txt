Aipet 0.1.2 for Windows x64 - personal edition, without sprite usage counters

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
The pet and its optional AI activity hooks use the included runtime. No separate
Node.js installation is needed. Open Connections > Connect Codex to register its
ten hooks. The button backs up an existing user hooks.json beside it, uses
CODEX_HOME if set (otherwise %USERPROFILE%\.codex), preserves unrelated settings
and hooks, and updates recognized older Aipet definitions. Repeated unchanged
connections make no write or extra backup; invalid or unsafe configuration is
refused. Review and trust new or changed hooks yourself in Codex's /hooks view
or Settings > Coding > Hooks > Local. Registration does not prove signal delivery.
Claude Code stays manual: back up its settings and merge the JSON shown by
Connections > Review setup. Do not copy raw template files or overwrite an
entire existing configuration. Installation and startup never register hooks.

OPTIONAL POWERSHELL INSTALL
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Install.ps1 -DesktopShortcut -Launch
Use -InstallDirectory "D:\Apps\Aipet" to choose an unused application folder.
ExecutionPolicy Bypass applies only to the installer PowerShell process; no
machine or user policy is changed. Managed policies may still prevent execution.

UNINSTALL / REPLACE
To upgrade 0.1.0 or 0.1.1, turn off Start at Windows sign-in in Aipet Privacy,
quit Aipet, uninstall the previous registered copy, then install 0.1.2 at the same
final path. Click Connect Codex to update recognized old Aipet definitions, then
review/trust the changed hooks again. Inspect customized handlers left untouched;
update Claude's manual setup when needed. Installation alone does not update hooks.
Use Windows Settings > Apps > Installed apps,
or run Uninstall.cmd inside the installed Aipet directory. Uninstall removes
only recorded, unchanged program files, its own shortcuts and registration.
Modified or added files are retained. Your %USERPROFILE%\.aipet data and all
Claude/Codex settings are preserved. Uninstall before installing another build.
If you later enable startup, turn it off in Aipet's Privacy pane before
uninstalling. If you connect AI hooks, manually remove only Aipet's hook entries
from your AI configurations when disconnecting. The installer never edits them.

DIAGNOSE NO SIGNAL
Run the included Diagnose-Codex.ps1 from the extracted archive directory:
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\Diagnose-Codex.ps1
The default is read-only. It prints JSON counts, path-match/existence booleans and
the latest own Codex event state/time, with no commands, full paths or content.
For a custom install, add -AppDirectory "D:\Apps\Aipet\app\resources\app".
Adding -Probe explicitly writes one synthetic Codex thinking event using Aipet's
own bridge. It never runs configuration commands or a task in Codex, changes hook
configuration/trust, or reads conversations. Paste the JSON when troubleshooting.

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
