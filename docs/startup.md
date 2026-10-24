# Windows login startup and dormant mode

Aipet can register a startup entry for the current Windows user. Its login launch adds `--background`: the application starts as an exitable tray process and waits for a supported AI application or a fresh activity signal. The foreground/presence detector reads only the allowlisted process names; generic terminal windows require hook metadata to identify their AI session. This does not install hooks or inspect conversations, project files, window titles, or process arguments.

The desktop application owns dormant/wake/manual-hide behavior. The startup module only reads and changes the login registration. Manual Hide should remain in effect until the user explicitly resumes the pet. Quit ends Aipet for that Windows session; there is no watchdog or service to restart it. The startup entry remains available for the next login unless disabled.

## Registration

The only writable registry value is:

```text
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
    Aipet    REG_SZ    "<known local Aipet executable>" "--background"
```

Development launches may include the known application directory as an additional quoted argument. Startup uses the launch specification chosen inside the main process, never a renderer-supplied command. The module normalizes the local absolute executable path, Windows-quotes every argument, appends one `--background`, and rejects control characters, UNC paths and commands longer than 260 characters. No command shell interprets the path or arguments. Keep a packaged application at a stable trusted location; moving or deleting it makes the old startup entry stale. Re-enable startup from the moved application to update its entry.

`HKCU\Run` launches at user login rather than machine boot. It requires no administrator rights. Windows can delay the launch and does not guarantee an immediate startup time. These limits are documented in Microsoft's [Run and RunOnce registry reference](https://learn.microsoft.com/en-us/windows/win32/setupapi/run-and-runonce-registry-keys).

Writes and removal invoke the fixed system `reg.exe` with argument arrays, `shell: false`, `windowsHide: true`, a five-second deadline and bounded output. They target only the 64-bit current-user `Run\Aipet` value. Queries use one fixed independent PowerShell program with no profile or execution-policy flag. It calls the .NET registry APIs read-only for exactly `Aipet` under Run and StartupApproved; it does not enumerate other startup commands. A typed query distinguishes an absent value from an access failure, which `reg query`'s generic failure code cannot do reliably across localized systems. See Microsoft's [reg add](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/reg-add) and [reg query](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/reg-query) references.

## Effective status and Windows approval

The UI should display the module's verified result, rather than persisting a desired boolean as proof of registration. States distinguish no registration, the current launch registered, a different/stale launch, Windows disabling the entry, unknown approval data, and a registry error. The module reads the registration back after changing it and serializes changes so rapid toggles preserve the last request. Unexpected existing registry data and raw subprocess errors are not returned to the renderer.

Windows Settings or Task Manager can disable startup separately from the Run value. Aipet reads its own StartupApproved entry for diagnostics and never modifies that approval value. Known approval states are reported conservatively; unfamiliar formats remain unknown. If Windows disabled Aipet, enable it through Windows **Settings → Apps → Startup** or Task Manager's **Startup apps** page. Enabling Aipet's preference does not override that operating-system choice. Electron documents the distinction between registration and startup approval in [its login-item API](https://www.electronjs.org/docs/latest/api/app#appgetloginitemsettingsoptions); its [Windows implementation](https://github.com/electron/electron/blob/main/shell/browser/browser_win.cc) provides the basis for the narrow read-only diagnostic. This diagnostic does not establish that every Windows policy permits launching or that the next login has already been tested.

Disabling startup removes only `Run\Aipet`. It does not delete the entire Run key, other applications' values, Windows approval settings, application preferences, or activity metadata. Disabling startup does not quit the already-running tray process; use Quit for that.

## Tests and activation

`tests/startup.test.cjs` uses injected in-memory registry adapters and fake subprocesses. It checks quoting, invalid/long commands, read-back verification, idempotent removal, disabled/unknown approval, stale registrations, redacted failure handling, rapid toggles, and fixed native registry arguments. Desktop test mode blocks real registry access unless a test adapter is explicitly supplied. Tests do not register startup or install AI hooks.

Actual activation is a separate user-authorized action performed after validating the packaged application. The application does not register startup merely because this module is imported, the installer-free folder is built, or a test runs. A real login remains necessary to verify Windows' scheduling and approval behavior end to end.
