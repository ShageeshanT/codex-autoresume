---
description: Control AutoResume or prepare a handoff of this Codex session
argument-hint: [status|on|off|start|recover|stop]
---

Use the installed autoresume skill at `__SKILL_PATH__` to handle the following action:

$ARGUMENTS

If no action was supplied, show status. Read the skill and run its deterministic helper. Report whether the action was acknowledged, is pending, or requires the user to hand off the current session. A custom prompt cannot attach the wrapper to an ordinary running Codex terminal, and it needs available model quota to execute. Do not claim that supervision is active unless the helper confirms it.
