# Terminal implementation plan

Based on `codex-autoresume-complete-plan.md`. Desktop integration is out of scope for this build.

1. **Foundation:** TypeScript package, explicit state transitions, validated atomic JSON storage, single-owner locking, metadata-only event logs, CLI commands.
2. **Terminal integration:** node-pty passthrough for the normal Codex TUI; a loopback WebSocket bridge to a private stdio app-server. Observe structured thread and turn events to identify the exact session and quota failure. Forward normal approval requests to the TUI unchanged.
3. **Recovery:** persist reset deadlines, check the wall clock periodically, query `account/rateLimits/read` at reset, retain all exhausted windows, back off on errors, resume the exact UUID only. Opt-in continuation, Git/content fingerprint and session activity guards, durable at-most-once claim before launching a continuation.
4. **Validation:** fake app-server and fake terminal fixtures; state, persistence, quota, bridge, cancellation, recovery, duplicate and PTY tests; build/typecheck; installed Codex handshake and terminal smoke tests without sending model work.
5. **Delivery:** runnable demo, installation and usage instructions, documented compatibility and remaining real-account validation.

## Integration decision

The installed CLI is 0.153.4 and supports `codex --remote` and `codex resume --remote`. The official app-server protocol exposes exact thread IDs, turn errors, stored thread reads, and account rate limits. Use these instead of treating rendered chat text as authoritative. This is a deliberate adaptation of the source plan's preference for structured signals.

The app-server/remote interface is experimental. Unsupported versions or unknown event shapes must pause automation rather than infer permission to continue. No raw terminal transcript, credentials, or original prompts are stored by AutoResume. Codex retains its own normal session history.

## Acceptance

- `car` opens the Codex terminal and preserves input, resizing, colors and approvals.
- A structured quota failure saves the exact thread and reset deadline.
- No continuation before a fresh allowance check succeeds.
- Other failures do not schedule quota recovery.
- Restarts, sleep and cancellation preserve safe behavior.
- No repeated continuation after a crash at the dispatch boundary.
- `status`, `recover`, `cancel`, `logs`, `doctor`, and a service-free demo work.

## Verification record

Completed on 2026-09-26:

- Foundation, CLI, authenticated local bridge, PTY passthrough, scheduler, verification, recovery and opt-in continuation implemented.
- `npm run check`: production and test TypeScript checks passed.
- `npm test`: **28 tests passed**, including a real Windows PTY with fake Codex, approval forwarding, auth/network rejection, weekly/model windows, restart, cancellation races, changed permissions, changed Git content, subdirectories and duplicate event delivery.
- `car doctor`: connected to the installed Codex 0.153.4 app-server and confirmed ChatGPT authentication without requesting a model turn.
- Real terminal smoke: initialized the standard Codex TUI through the wrapper, captured its exact session ID and effective policy, skipped the optional update prompt, and stopped without submitting any task or approval.
- `npm pack --dry-run`: package contents inspected; only compiled code, package metadata and README included. No package published and no global alias installed.
- Fixed two issues found by actual Windows testing: the remote URL parser requires a root URL (the bridge now uses its supported bearer-token environment option), and node-pty output workers require isolation in a short-lived host to avoid keeping the supervisor alive after terminal exit.

Remaining before a production release: observe an actual exhausted-account reset, manually exercise menus/paste/resize in Windows Terminal, test macOS/Linux, and validate future Codex protocol versions. App-server/remote mode remains experimental. The current prototype requires `car recover` after reboot and intentionally pauses uncertain dispatches.

## Inside-Codex integration

- Added and installed `/prompts:autoresume` plus the `autoresume` skill under the user's Codex home. No existing configuration or unrelated skills changed.
- Supported actions: `status`, `on`, `off`, `start`, `recover`, `stop`.
- `on`/`off` use run- and session-scoped requests, with explicit supervisor acknowledgment. The wrapper propagates its state directory to Codex subprocesses. Enabling halfway through a quota wait is rejected because no earlier Git snapshot can be recovered safely.
- Ordinary Codex sessions receive an exact-session handoff command; attaching to an existing unsupervised terminal is not implemented.
- Production/test typechecks and all **31 tests passed**. The skill validator passed and the installed Codex app-server reported `autoresume` as enabled. No model turn was used for discovery verification.

## Portable installation and repository delivery

Verified on 2026-09-27:

- Added detailed Windows installation, optional terminal aliases, inside-Codex integration, updates, uninstall, troubleshooting and experimental macOS/Linux instructions to the README.
- Generated commands require only Node.js and quote paths for the host shell. Removed the development machine's optional shell-proxy dependency from the integration templates.
- Added a managed integration uninstaller that preserves unrelated Codex files and saved state.
- Separated the npm install command's build hook to preserve custom home paths containing spaces on Windows.
- Production/test typechecks and all **35 tests passed**, including npm argument forwarding and integration install/reinstall/uninstall checks.
- A clean source copy installed locked dependencies, compiled, launched the CLI, passed the real-PTY fake-process recovery demo, and installed/uninstalled the Codex integration in a custom home containing spaces. No model requests were made.
- Reviewed all 32 repository files for local credentials and machine-specific user paths; dependency downloads use the public npm registry. Generated output, dependencies, caches and local runtime state remain excluded from Git.

## Installed command verification

- Installed locked dependencies, rebuilt, refreshed the managed integration, and registered `car` and `codex-autoresume` in the user's npm command directory.
- Both aliases report version 0.1.0. Doctor connects to Codex CLI 0.153.4 with ChatGPT authentication, and the app-server reports the AutoResume skill as enabled.
- An actual TUI menu check found that this CLI does not expose the deprecated `/prompts:autoresume` entry. Earlier installation guidance incorrectly treated the legacy prompt file as sufficient proof of support.
- Verified AutoResume appears in `/skills` after choosing **List skills**. Corrected the README and installer output to use this supported path or `$autoresume`. The legacy prompt template remains for older compatible CLIs.
- Menu checks and helper checks submitted no model prompt. The current unsupervised conversation still requires an explicit terminal handoff before automatic recovery can operate.
