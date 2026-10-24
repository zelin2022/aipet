# Windows portable deployment

`npm run package` builds `dist/Aipet-win32-x64/`. The launch executable is **`electron.exe`**, with the original Electron filename, icon, version metadata, and executable bytes. It directly loads our application from `resources/app/`, following [Electron's documented manual distribution layout](https://www.electronjs.org/docs/latest/tutorial/application-distribution). No proxy launcher, installer, signing certificate, trust rule, security exclusion, or updater is created by packaging.

The studio, tray, and optional Windows shortcuts use Aipet's own icon. The runtime executable retains Electron's vendor identity. The output contains the whole runtime, so the application can run without Node.js, npm, a terminal, or the source checkout once the folder is copied to a stable location. Keep the entire output folder together.

## Build and verify

```powershell
npm ci
npm run package
node scripts/test-portable.mjs
```

The build copies the locked, installed official Electron runtime without editing native files. It requires Electron 45.0.0 and pins the original x64 executable SHA-256:

```text
8e84549b05d27d444da2957653200d1e0ac287eff0fc5722b92835b9e0821a59
```

Every runtime file is hashed after copying. `runtime-provenance.json` records those hashes, the pinned executable, the official release source, and the distribution archive checksum declared by Electron's npm package. That archive checksum is recorded as expected metadata; packaging does not download the archive or claim to verify a separate cached archive. The vendor sample `resources/default_app.asar` is excluded so our own `resources/app` loads directly.

The application payload is explicitly allowlisted. The build verifies its staged file hashes and all original character assets. Source references, tests, development scripts, `node_modules`, and production npm dependencies are excluded. It writes `dist/package-report.json` only after auditing the built package. Plain files preserve compatibility with the application's separate read-only PowerShell foreground helper.

Quit Aipet before rebuilding or replacing its portable folder. Keep user data in the app's separate local profile; rebuilding does not copy or reset that profile.

Replacement first moves the old output into a uniquely named checked backup outside staging, then installs the completed new folder. A locked old folder fails before any of its files are removed. Failed installation rolls back; if rollback also fails, both recovery paths are retained and reported. Backup cleanup happens only after successful installation. Three isolated tests cover locked-folder preservation, rollback after failed installation, and successful replacement.

`node scripts/test-portable.mjs` starts the actual output executable directly with `--background`, supplies isolated temporary `USERPROFILE` and `LOCALAPPDATA` values to its child, checks that the app remains running and creates its own `.aipet` profile, and stops only that test process tree. It never changes the normal Aipet profile, AI settings, login startup, or system security policies. The separate desktop smoke test exercises UI behavior; this test verifies the real portable launch path.

## Launcher and login startup

`deployment.json` describes the portable launch target:

```json
{
  "mode": "electron-portable",
  "executable": "electron.exe",
  "arguments": ["--background"],
  "workingDirectory": ".",
  "appDirectory": "resources/app"
}
```

A user-facing `Aipet.lnk` should target the absolute `electron.exe` path, pass `--background` for login startup, set its working directory to the distribution folder, and use `resources/app/renderer/icon.ico` as the shortcut icon. Normal interactive launches can omit `--background`. The app supplies the shortcut/startup controls; packaging itself does not enable startup. Moving the folder requires recreating its shortcuts.

The shortcut helper previews the exact absolute paths by default:

```powershell
node scripts/shortcut.mjs
node scripts/shortcut.mjs --test
node scripts/shortcut.mjs --install
```

`--test` creates and reads back a shortcut only in a temporary folder, then removes that folder. `--install` creates `dist/Aipet.lnk` and the current user's Start Menu Programs `Aipet.lnk`, pointing directly at the unmodified portable `electron.exe` with `--background` and Aipet's independent icon. It verifies target, arguments, working directory, and icon through Windows' shortcut COM API. It refuses to replace an existing shortcut with a different target. Neither operation launches the app, changes login startup, writes registry entries, adds executable wrappers, or alters security policies. Run installation after the final package has been built in its stable folder.

## Why native branding is omitted

On this computer, the first branded `Aipet.exe` was rejected by Windows on 2026-10-23 at about 09:41 America/Edmonton. Read-only diagnostics restricted to that file found CodeIntegrity events 3033 and 3077, plus Smart App Control event 3118. The blocking policy was `VerifiedAndReputableDesktop`, requested signing level 2, validated level 1, status `0xc0e90002`. [Microsoft describes event 3077 as an App Control enforcement block](https://learn.microsoft.com/en-us/windows/security/application-security/application-control/app-control-for-business/operations/appcontrol-debugging-and-troubleshooting).

The branded and original binaries were both reported `NotSigned`. Their code and other native sections matched; the resource section and related PE layout changed during normal icon/version customization. The evidence establishes a local policy rejection after the resource change. It does not establish a malformed executable or a signature-chain diagnosis. Changing the executable changed its file hash and identity under the host's controls.

The portable build preserves the original vendor runtime instead of customizing its PE resources. A direct launch of that built `electron.exe` succeeded on this computer in an isolated profile, and its bytes matched the pinned original runtime. This observation does not guarantee authorization on every Windows device: the runtime remains unsigned according to `Get-AuthenticodeSignature`, and local controls still apply. If a device rejects it, keep its protection enabled and seek the device owner's approved deployment/signing route. This project does not alter App Control, Defender, reputation, execution policies, trust stores, or file security markings.
