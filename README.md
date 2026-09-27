# Codex AutoResume

**Keep a Codex terminal session recoverable when a usage limit interrupts your work.**

AutoResume opens the regular Codex terminal, remembers the exact interrupted session, waits for the reported reset, checks the current allowance, and reopens that session. You can opt in to submitting one continuation prompt after the checks pass.

```text
Launch AutoResume → work in Codex → usage limit interrupts the turn
                                      ↓
                        save session and reset information
                                      ↓
                         wait → verify allowance → resume
```

OpenAI controls the allowance and its reset. AutoResume does not reset quotas, redeem reset credits, switch accounts, purchase credits, or approve Codex tool actions for you.

> **Status: terminal prototype.** Developed and tested on Windows with Node.js 24.11.1 and Codex CLI 0.153.4. The integration uses Codex's experimental app-server/remote interface. The fake-process recovery tests and real CLI startup checks pass; an actual exhausted-account reset has not yet been tested. macOS and Linux instructions are provided for experimentation, but those platforms have not been validated. Desktop-app control is not implemented.

## Contents

- [Requirements](#requirements)
- [Install on Windows](#install-on-windows)
- [Install on macOS or Linux](#install-on-macos-or-linux)
- [Everyday use](#everyday-use)
- [Commands inside Codex](#commands-inside-codex)
- [Command reference](#command-reference)
- [Sleep, restart, and recovery](#sleep-restart-and-recovery)
- [Update and uninstall](#update-and-uninstall)
- [Troubleshooting](#troubleshooting)
- [How it works and what it stores](#how-it-works-and-what-it-stores)
- [Development](#development)

## Requirements

| Requirement | Details |
| --- | --- |
| Node.js and npm | Node.js **22 or newer**. Node.js 24 LTS is the tested major version. Install from [nodejs.org](https://nodejs.org/en/download). |
| Git | Needed to clone this repository and to guard automatic continuation against workspace changes. Install from [git-scm.com](https://git-scm.com/downloads/). |
| Codex CLI | Must support `--remote`, `--remote-auth-token-env`, and the app-server methods this adapter uses. Tested with **0.153.4**; newer releases need compatibility checks. |
| Codex authentication | Sign in to Codex with **ChatGPT**. The quota-recovery flow relies on ChatGPT-backed allowance information. AutoResume does not require its own API key. |
| Interactive terminal | PowerShell in Windows Terminal, or a terminal on macOS/Linux. The real Codex UI cannot run through redirected stdin/stdout. |
| Git project for automatic prompts | Required for `--auto-continue`. The default reopen-only mode can be used outside Git. |

AutoResume itself does **not** require RTK, Docker, a web server, or a separate backend account. It runs locally. Codex still needs its normal network access and login.

## Install on Windows

### 1. Install and check the prerequisites

Install Node.js and Git using the links above. Open a **new PowerShell window** after installation so it has the updated PATH, then check:

```powershell
node --version
npm --version
git --version
```

If PowerShell blocks `npm.ps1`, use `npm.cmd` in place of `npm` in the commands below. Changing the machine's execution policy is not required.

### 2. Install Codex and sign in

If Codex is already installed and working, keep that installation and check its version. Otherwise:

```powershell
npm install -g @openai/codex
codex --version
codex
```

Choose **Sign in with ChatGPT** when Codex prompts you. Once it opens successfully, enter `/quit` to return to PowerShell. These are the npm installation and sign-in steps from the [official Codex CLI documentation](https://developers.openai.com/codex/cli/).

The npm command installs the current Codex release, which may differ from the tested version. Run the compatibility check in step 4 before relying on AutoResume. A successful startup check does not validate every behavior of a newer protocol version.

### 3. Clone and build AutoResume

Run these commands in a directory where you keep your projects:

```powershell
git clone https://github.com/ShageeshanT/codex-autoresume.git
cd codex-autoresume
npm ci
npm run build
```

`npm ci` installs the dependency versions in `package-lock.json`, including development dependencies needed to compile TypeScript. Keep the checkout in a location you control; do not copy someone else's `node_modules` directory. The compiled `dist` directory is created by the build and is intentionally absent from Git.

### 4. Check the installation

From the AutoResume checkout:

```powershell
npm run demo
npm start -- doctor
```

The **demo** launches fake Codex processes in a real pseudo-terminal, simulates a short quota wait, and resumes once. It does not contact Codex or spend model quota. Expect a final `Demo passed: one continuation` message.

The **doctor** command checks your installed Codex, loads the PTY dependency, opens the local status protocol, and reports the authentication type. Expect `Protocol: connected` and `Authentication: chatgpt`. Doctor starts no model turn; it does not itself perform the full quota-reset test.

### 5. Add the terminal commands to PATH

This step is optional, but makes the app easier to use from any project:

```powershell
npm link
car --version
```

This registers both `car` and `codex-autoresume`, pointing to **this checkout**. Keep the checkout in place. If you move it, rebuild and run `npm link` again. See [troubleshooting](#troubleshooting) if PowerShell does not recognize `car` or blocks its `.ps1` launcher.

You can skip global registration and use `npm start -- ...` from the checkout, or invoke its compiled CLI by absolute path:

```powershell
node "C:\path\to\codex-autoresume\dist\cli.js" -C "C:\path\to\your-project"
```

### 6. Start a supervised session

After `npm link`, switch to the project you actually want Codex to work on:

```powershell
cd "C:\path\to\your-project"
car
```

Type your task inside the Codex UI. By default, a verified reset **reopens the saved session and waits for your input**.

To submit a continuation automatically after the reset, opt in when starting:

```powershell
car --auto-continue
```

Keep the terminal open and the machine awake if you want it to continue as soon as allowance returns. This mode requires an unchanged Git workspace at the time of resumption.

## Install on macOS or Linux

These platforms are experimental for this project. Install Node.js 22+ and Git, then follow the same source-install flow in bash or zsh:

```bash
npm install -g @openai/codex
codex
# Sign in with ChatGPT, then use /quit to return to your shell.

git clone https://github.com/ShageeshanT/codex-autoresume.git
cd codex-autoresume
npm ci
npm run build
npm run demo
npm start -- doctor
npm link

cd /path/to/your-project
car --auto-continue
```

If your npm global directory is not writable, use a user-owned Node.js installation or skip `npm link` and run the compiled CLI by absolute path. If `node-pty` needs to compile a native addon, consult the [native-build troubleshooting](#native-addon-installation-fails).

## Everyday use

Start from the target project after installing the terminal aliases:

```powershell
car
car --auto-continue
car --resume YOUR_SESSION_UUID
```

Or start from the AutoResume checkout without adding aliases:

```powershell
npm start -- -C "C:\path\to\your-project" --auto-continue
```

To retain your preferred model and permission choices, pass supported Codex options after `--`:

```powershell
car --auto-continue -- --model YOUR_MODEL --sandbox workspace-write --ask-for-approval on-request
```

Replace `YOUR_MODEL` with a model available to your account. AutoResume does not choose a model for you. Enter the task itself in the Codex UI; the wrapper does not store an original prompt as a launch argument.

On a confirmed interruption, it saves the session and tells you when it will next check allowance. A known reset has a 45-second grace period. Unknown reset information causes a status check after 15 minutes, with later checks up to 30 minutes apart. A timestamp alone never authorizes a continuation.

The optional continuation prompt is:

> Continue the interrupted task from the current session state. Do not redo completed work.

## Commands inside Codex

### Install the skill and slash prompt

From the AutoResume checkout:

```powershell
npm run install:codex
```

Restart Codex CLI, then use:

```text
/prompts:autoresume status
/prompts:autoresume on
/prompts:autoresume off
```

The corresponding skill invocations are `$autoresume status`, `$autoresume on`, and `$autoresume off`. `/autoresume` by itself is not a built-in Codex command. Codex's [custom prompt mechanism](https://learn.chatgpt.com/docs/custom-prompts) uses `/prompts:` and is deprecated in favor of [skills](https://learn.chatgpt.com/docs/build-skills); this installer provides both entry points.

| Action | Result |
| --- | --- |
| `status` | Shows saved state and whether this session has a supervisor. |
| `on` | Enables continuation in an already-supervised session; otherwise gives a handoff command. |
| `off` | Disables prompt submission. The normal verified reopen behavior remains. |
| `start` | Gives a command to reopen this exact session through AutoResume. |
| `recover` | Gives the command for interactive recovery of the saved wait. |
| `stop` | Cancels supervision and closes its wrapper terminal. Saved Codex history remains. |

**A slash prompt cannot attach this version to a terminal started with ordinary `codex`.** For such a session, finish the current turn, use `/quit`, and run the returned handoff command in the indicated shell. It uses the exact session UUID, not a potentially unrelated latest session.

Use these commands **before exhausting model allowance**. The prompt/skill needs a model turn to execute. Once the external supervisor is running, its timer and status checks operate independently of the model. Enable automatic continuation before the interruption so the supervisor can capture the workspace fingerprint at the right time.

The installer writes only these files under `CODEX_HOME`, or `~/.codex` when that variable is unset:

```text
prompts/autoresume.md
skills/autoresume/SKILL.md
skills/autoresume/agents/openai.yaml
```

It refuses to overwrite an unrelated file with the same name and does not change `config.toml`. Instructions are generated for the local machine and point to your checkout's compiled CLI. Rerun the installer after moving the checkout or updating the integration.

For a custom Codex home, pass it explicitly:

```powershell
npm run install:codex -- --codex-home "C:\path\to\custom-codex-home"
```

## Command reference

| Terminal command | Purpose |
| --- | --- |
| `car` | Open supervised Codex. |
| `car --auto-continue` | Opt into automatic prompt submission after verified resets. |
| `car --resume UUID` | Begin with an existing saved session. |
| `car -C PATH` | Work in a specific project directory. |
| `car status` | Inspect the saved session and next check time. |
| `car status --json` | Read saved state as JSON. |
| `car recover` | Recover a persisted quota wait. |
| `car cancel` | Cancel supervision; preserves Codex session history. |
| `car logs` | Show the latest 30 operational events and log path. |
| `car doctor` | Check installation, protocol connectivity, and login type. |
| `car config` | Show built-in defaults. This is not a configuration editor. |
| `car demo` | Exercise fake-process recovery without service requests. |
| `car --help` | Show options and supported Codex passthrough flags. |

Before `npm link`, substitute `npm start --` for `car` while in the checkout: for example, `npm start -- status`.

Supported Codex passthrough options are `--model`/`-m`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--profile`/`-p`, `--add-dir`, `--enable`, `--disable`, `--search`, `--no-alt-screen`, and `--approve-for-me`. Arbitrary `--config` overrides, remote endpoints, images and original prompts are not accepted as persisted passthrough arguments.

Use `--codex PATH` to select a native Codex executable when automatic discovery fails. On Windows, give the actual `codex.exe`, not a PowerShell script.

Use `--state-dir PATH`, or the `CAR_STATE_DIR` environment variable, to choose a separate supervision state directory. Use the same setting for `status`, `cancel`, and `recover`:

```powershell
car --state-dir "C:\path\to\autoresume-state" --auto-continue
car --state-dir "C:\path\to\autoresume-state" status
```

One supervisor owns a state directory at a time. Separate directories do not coordinate access to the same Codex session.

## Sleep, restart, and recovery

- **While waiting:** leave the terminal open. Ctrl+C saves the waiting state and exits supervision. Inside the normal Codex UI, Ctrl+C is forwarded to Codex.
- **After sleep:** the running supervisor compares the wall clock with its saved deadline and checks allowance after the machine wakes.
- **After a reboot or a closed waiting terminal:** run `car recover`. There is no installed startup service or scheduled task.
- **To cancel:** run `car cancel` from another terminal, with the same state directory if you specified one.
- **If state is `PAUSED`:** inspect `car status` and `car logs`. Reopen the displayed session manually with `codex resume UUID` when appropriate. A new wrapper run may replace a paused record.

Recovery deliberately pauses an uncertain dispatch rather than resending a continuation. If Codex was updated while a wait was saved, use manual recovery and start a new supervision run with the new version. Avoid using the same session in another client while AutoResume is waiting.

## Update and uninstall

### Update this checkout

Stop any running wrapper first. From the AutoResume checkout:

```powershell
git pull --ff-only
npm ci
npm run build
npm run demo
npm start -- doctor
```

If you installed the optional Codex skill/prompt, refresh it too:

```powershell
npm run install:codex
```

An existing `npm link` continues pointing at the checkout. Restart Codex after refreshing the integration. Update the underlying Codex CLI separately using its normal installation method; protocol compatibility is not assumed across versions.

### Remove the optional skill and slash prompt

From the checkout:

```powershell
npm run uninstall:codex
```

For a custom installation, supply the same home used at install time:

```powershell
npm run uninstall:codex -- --codex-home "C:\path\to\custom-codex-home"
```

The uninstaller removes only the three files carrying this installer's marker. It preserves unrelated files, Codex configuration, Codex sessions and AutoResume's saved state. Empty integration directories may remain. Restart Codex afterward.

### Remove the global terminal aliases

```powershell
npm uninstall -g codex-autoresume
```

After stopping all supervisors and removing the optional integration/aliases, you can remove your AutoResume checkout normally. Its separate state directory remains available for inspection. Do not remove Codex's own home directory as part of uninstalling AutoResume.

## Troubleshooting

### `car` is not recognized, or PowerShell blocks `car.ps1`

Run `npm link` from the built checkout and open a new terminal. Check the npm global prefix with `npm prefix -g`; its executable directory must be on PATH. On Windows, try `car.cmd` or `codex-autoresume.cmd` if script execution is blocked. A direct `node "...\dist\cli.js"` invocation also works without global aliases.

### `Cannot find a native Codex executable`

Confirm `codex --version` works in the same terminal. On Windows, the wrapper recognizes a native `codex.exe` and the normal npm-installed Codex layout. For a different layout, pass `--codex "C:\full\path\to\codex.exe"`. `where.exe codex` shows launcher locations; a `.cmd` or `.ps1` launcher is not the native binary itself.

### `lacks --remote support` or protocol/permission metadata is incompatible

The installed CLI does not expose the adapter's expected capabilities. Review its version and the project's tested version above. Do not assume that a version change is compatible because the TUI opens. Keep the saved state, use manual `codex resume UUID` if needed, and report the failure with version information.

### Authentication is not `chatgpt`

Sign in through Codex using **Sign in with ChatGPT**, then rerun `car doctor`. AutoResume cannot infer ChatGPT quota eligibility from an API-key-only or another provider's account. It does not manage your login credentials.

### Native addon installation fails

`node-pty` includes prebuilt binaries for some environments and otherwise invokes a native build. If `npm ci` reports `node-gyp`, Python, MSVC or compiler errors, install the applicable build tools and retry:

- **Windows:** Python plus Visual Studio Build Tools with the **Desktop development with C++** workload and a Windows SDK.
- **macOS:** Xcode Command Line Tools, commonly installed with `xcode-select --install`.
- **Debian/Ubuntu:** a Python 3 interpreter, `make`, and a C/C++ toolchain, commonly provided by `sudo apt-get install python3 make g++`.

Follow the current [node-gyp installation guidance](https://github.com/nodejs/node-gyp#installation) for your platform and architecture. If you changed Node.js versions, rerun `npm ci` to reinstall the native dependency for that environment. Do not suppress dependency install scripts with `--ignore-scripts` for the normal installation.

### The slash command or skill does not appear

Run `npm run install:codex` from the checkout, check the printed destination, and restart Codex CLI. The slash name is `/prompts:autoresume`; the skill name is `$autoresume`. If you use `CODEX_HOME`, ensure the installer and Codex use the same value. An existing unrelated `autoresume` file is left untouched; inspect or rename that conflict yourself.

### `on` prints a handoff command

The current session was not launched through this wrapper, or its supervisor is no longer running. Follow the exact-session handoff after finishing the turn and exiting Codex. The message does not mean automation has been enabled.

### Automatic continuation pauses because the workspace changed

This is the duplicate-work guard. It hashes tracked and untracked, non-ignored Git content, including files that were already modified. Missing Git information, submodules, unreadable files and individual files over 32 MiB prevent an automatic prompt. Reopen manually, or use the default reopen-only mode for future sessions.

### There is already a saved session, or another supervisor owns the directory

Inspect `car status` first. Use `car recover` for a saved wait or `car cancel` to retire that supervision. A second supervisor cannot own the same state directory. Status shows saved state, so `RUNNING` alone is not proof that the process is still alive after a crash.

### Waiting continues after the displayed reset

A fresh account check may still report an exhausted weekly/model window, a spending or credit block, or unavailable status information. The supervisor waits or backs off until it has positive evidence of usable allowance. It does not send trial model prompts or redeem a reset credit.

### Report a problem

Open an [issue](https://github.com/ShageeshanT/codex-autoresume/issues) with your OS, `node --version`, `codex --version`, `car --version`, the command you ran, and whether `car demo` and `car doctor` passed. Include relevant operational events from `car logs` after reviewing them. Do not upload credentials, authentication files or private chat transcripts.

## How it works and what it stores

The regular Codex TUI runs in a pseudo-terminal and connects through an authenticated loopback WebSocket bridge to a dedicated stdio app-server. Native thread/turn events identify the session and quota failure. Rendered chat text cannot trigger recovery.

At reset, `account/rateLimits/read` must report usable allowance in every reported bucket. The latest saved turn must still match the interrupted turn and be inactive. Automatic submission additionally requires an unchanged Git fingerprint. Effective sandbox and approval settings are checked before the resumed UI receives success and can send its continuation.

A durable claim is written **before** dispatching a continuation. This provides at-most-once submission across uncertain crashes, at the cost of sometimes requiring manual recovery. There is a five-resume cap per supervision run. The thread check is a snapshot, not a distributed lock across all clients; the Git guard cannot account for ignored files or external databases and other side effects.

Default state locations:

| Platform | Directory |
| --- | --- |
| Windows | `%LOCALAPPDATA%\codex-autoresume` |
| macOS | `~/Library/Application Support/codex-autoresume` |
| Linux | `$XDG_STATE_HOME/codex-autoresume`, or `~/.local/state/codex-autoresume` |

| File | Contents |
| --- | --- |
| `state.json` | Session/turn identifiers, working directory, launch options, timestamps, fingerprints and dispatch claims. Written using atomic replacement. |
| `events.jsonl` | Operational state transitions and timing metadata. No automatic log rotation yet. |
| `cancel.json` | A run-specific cancellation request. |
| `control.json` | Session-scoped continuation controls from the optional skill/prompt. |

AutoResume does not persist original prompts, terminal transcripts, account details or credentials. Codex maintains its own normal session history separately. An unrecognized or corrupt state file is preserved and rejected instead of silently overwritten; inspect it before moving it aside.

## Development

```powershell
npm ci
npm run check
npm test
npm run demo
```

`npm test` builds the project and runs unit/integration tests, including a fake Codex process in a real PTY. Tests cover quota windows, timestamps, persistence, locking, Git fingerprints, restart/sleep handling, cancellation, duplicate events, permission preservation, approval forwarding, session-scoped controls and integration installation/uninstallation. They do not need a live account or model requests.

```text
src/
  adapters/       Codex discovery, protocol bridge, PTY host and terminal I/O
  commands/       Controls invoked from inside Codex
  core/           Supervisor, quota interpretation, state and fingerprints
  demo/           Service-free fake Codex and demo
  platform/       Shell quoting for generated commands
integrations/     Portable Codex skill and slash-prompt templates
scripts/          Integration installer/uninstaller
tests/            Unit and integration tests
```

See [PLAN.md](PLAN.md) for implementation decisions and verification history. [The original project brief](codex-autoresume-complete-plan.md) also contains future ideas, including desktop support; it is not a statement that every planned feature is implemented.

Protocol references: [Codex app-server](https://learn.chatgpt.com/docs/app-server), [Codex CLI](https://developers.openai.com/codex/cli/), [skills](https://learn.chatgpt.com/docs/build-skills), and [custom prompts](https://learn.chatgpt.com/docs/custom-prompts).
