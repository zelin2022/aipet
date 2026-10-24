# Local performance and network inspection

Measured on 2026-10-23 on this Windows x64 development machine, including the side-by-side companion feature. The complete run took 59.9 seconds. Full process samples and connection counts are in the ignored local artifact `out/performance.json`. Run `npm run profile` (or `node scripts/profile.mjs`) to repeat deliberately after a relevant change. This is a short local characterization, not a hardware-independent performance promise.

## Observed results

Each phase had a two-second warmup followed by five one-second samples. All CPU counter intervals were usable in this run. The host has 32 logical CPUs and approximately 61.6 GiB of physical memory.

| Phase | BrowserWindows | Companions | Mean CPU, one-core equivalent | Mean CPU, whole machine | Mean summed working set | Mean private bytes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Initial dormant | 0 | 0 | 0.178% | 0.006% | 259.1 MiB | 160.6 MiB |
| Visible idle pet | 1 | 1 | 9.462% | 0.296% | 338.4 MiB | 209.1 MiB |
| Synthetic Codex coding | 1 | 1 | 5.211% | 0.163% | 353.6 MiB | 228.6 MiB |
| Claude reading beside Codex coding | 1 | 2 | 5.614% | 0.175% | 360.5 MiB | 223.0 MiB |
| Codex coding with reduced motion | 1 | 1 | 0.306% | 0.010% | 361.4 MiB | 227.5 MiB |
| Returned to dormant | 0 | 0 | 0.172% | 0.005% | 262.9 MiB | 186.4 MiB |

Dormancy avoided creating a BrowserWindow initially and destroyed the pet window when returning to sleep. The measured process count dropped from four to three after destruction. Electron can retain Chromium infrastructure and a spare renderer even with no BrowserWindows. Windowless therefore does not mean that only one process remains or that memory use falls to zero. Reduced motion substantially reduced CPU in this sample; it did not release the already-loaded artwork or Chromium allocations.

Both companions used one BrowserWindow and the same four-process Electron group as a single companion. In this run the duet's mean summed working set was 6.9 MiB above the preceding single coding phase. The higher idle CPU sample and changes in private-byte allocations show why these short, sequential measurements should not be treated as a precise incremental cost or a stable ranking of animation states. The duet phase asserted both original character images had decoded and reported distinct reading/coding states before measurement.

Electron's memory overhead is material for a small desktop companion. The summed working set includes shared pages more than once; it is not a unique physical-memory footprint. The private-byte column is supplied as another measure and also is not identical to resident RAM. A future native shell/helper migration should be considered if a lower memory budget becomes a requirement. These measurements do not establish a leak or prove long-running memory stability.

The separately launched foreground helper emitted valid minimized metadata in approximately 412 ms, produced no stderr, used 114.7 MiB working set at the final sample, and consumed approximately 1.179% of one core (0.037% of the whole machine) over a 5.3-second interval. Its startup compilation was excluded from steady-state CPU. The helper was stopped at the end. The Electron table excludes that separate helper; a normal application run also has the helper's cost when detection is enabled. Summing working sets across those components further duplicates shared memory.

## Measurement method

`scripts/profile.mjs` launches the project's pinned Electron runtime with `tests/runtime-profile.cjs --background`, `AIPET_DESKTOP_TEST=1`, and a newly created temporary data/inbox directory. `USERPROFILE`, `LOCALAPPDATA` and `APPDATA` are redirected into that same temporary directory. The harness asserts zero windows at initial dormancy, shows the pet through its real application API, and writes synthetic metadata events through the real independent adapter. The added duet phase supplies TEST presence for both providers, writes distinct Claude-reading and Codex-coding events, and asserts exactly one BrowserWindow with two decoded characters. It then removes only the isolated Claude event/session, returns to one Codex companion, enables reduced motion, and clears its remaining isolated event before automatic dormancy. It never installs provider hooks, changes login registration, touches authenticated AI configurations, or controls an existing Aipet process. The temporary profile directory is checked and removed afterward.

The harness calls `app.getAppMetrics()` for only its own Electron process group. It retains per-process CPU counters, working set, private bytes, and process type. CPU summaries use changes in `cumulativeCPUUsage` divided by measured wall time; the one-core percentage uses CPU seconds / wall seconds × 100, while whole-machine percentage divides by the number of logical CPUs. Framework `percentCPUUsage` samples are also retained. A previous run exposed a negative framework counter interval; the profiler preserves initial counters and automatically excludes/counts non-monotonic or missing intervals. None were excluded in this run. It does not display negative utilization as a real measurement. Electron documents these intervals and counters in its [CPUUsage reference](https://www.electronjs.org/docs/latest/api/structures/cpu-usage).

Working-set and private-byte values come from Electron's per-process kilobyte statistics and are divided by 1,024 for MiB. The report includes arithmetic means and observed working-set peaks, rather than claiming that a brief sample is a long-term maximum. See Electron's [MemoryInfo reference](https://www.electronjs.org/docs/latest/api/structures/memory-info).

This harness runs in TEST mode: no tray icon, startup query, global shortcut, or automatically spawned foreground helper is included in the phase measurements. Renderer `backgroundThrottling` is false in TEST mode, so the rendering workload can differ from a normal packaged launch. The helper is measured separately by its exact owned PID using `TotalProcessorTime` and `WorkingSet64`; only that child is stopped. Other activity on this development machine can affect scheduling, GPU work and working-set trimming. The profiling code and its metric polling also contribute some overhead. These are limits on comparison, not reasons to treat the numbers as production guarantees.

## Runtime network evidence

After each measured phase, a short hidden PowerShell process invokes Windows `Get-NetTCPConnection -OwningProcess <owned IDs>` and `Get-NetUDPEndpoint -OwningProcess <owned IDs>`. The IDs come exclusively from that profile instance's current `app.getAppMetrics()`. It does not query the whole machine's connections, inspect another Aipet instance or AI application's traffic, or persist remote addresses, local addresses, ports, packets or payloads. The report stores only counts and success/unavailable status. The filtering parameters are documented by Microsoft for [Get-NetTCPConnection](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-nettcpconnection) and [Get-NetUDPEndpoint](https://learn.microsoft.com/en-us/powershell/module/nettcpip/get-netudpendpoint).

All six snapshots succeeded and reported zero TCP connections, zero TCP listeners, zero established TCP connections, and zero UDP endpoints for the inspected profile processes. A failed, denied or unavailable query is reported as unavailable, never converted to an assumed zero. The measurement does not use administrator rights, register firewall rules, or start a packet-capture driver.

These are point-in-time connection snapshots. They can miss short-lived connections, connection attempts and DNS/network activity between snapshots. They are not packet-capture proof of zero network traffic, and they do not audit Windows or other applications. The separate code controls—local-only assets, renderer CSP and request blocking, no application network client, updater or telemetry—remain the intended runtime boundary.
