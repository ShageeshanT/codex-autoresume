---
name: autoresume
description: Control the local Codex AutoResume terminal supervisor, check its status, enable or disable continuation after usage resets, or prepare a handoff of the current Codex session to the wrapper. Use when the user requests AutoResume controls. This skill does not reset quotas or attach supervision to an ordinary running Codex terminal.
---

# AutoResume

Control the installed terminal wrapper through its deterministic helper. The CLI lives at `__APP_CLI__`.

Use the current project directory. Run the following through the shell, preserving the inherited `CODEX_THREAD_ID` and `CAR_STATE_DIR` variables:

```__SHELL__
__APP_COMMAND__ inside ACTION
```

Replace ACTION with the requested action. With no action, use `status`.

Follow the current workspace's shell-execution instructions when running this command. AutoResume itself needs only Node.js; optional shell proxies are not dependencies.

- `status`: Show saved state and whether the current session has an active supervisor.
- `on`: Enable automatic continuation in a session already supervised by the wrapper. Otherwise return a handoff command for this exact session.
- `off`: Disable prompt submission after reset; keep the wrapper's normal reopen behavior.
- `start`: Return a command to reopen the same session through the wrapper.
- `recover`: Return the interactive recovery command.
- `stop`: Cancel supervision and close its terminal. Use only when requested; use `off` if the user only wants to disable automatic prompts.

Report the helper's actual result. A handoff command or a pending request is not successful activation. If it gives a handoff, explain that the user must finish the turn, exit Codex with `/quit`, and run that command in the indicated shell. Do not launch a nested interactive Codex process through a non-interactive tool or open the same session in a second client while its turn is running. Do not guess the session ID or use `--last`; if the inherited ID is unavailable, obtain the exact ID from `/status`.

Invoke before the usage allowance is exhausted: skills and custom prompts require a model turn. Once the external supervisor is running, its timer and quota checks run independently of the model. Preserve Codex approval and sandbox settings. This workflow never redeems reset credits or purchases quota.
