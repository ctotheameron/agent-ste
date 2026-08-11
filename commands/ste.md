---
description: Control Simplified Technical English enforcement for this session
argument-hint: on|off|status|strict|strict off
allowed-tools: Bash
disable-model-invocation: true
---

Session state:

!`node "${CLAUDE_PLUGIN_ROOT}/bin/ste-session.mjs" "${CLAUDE_SESSION_ID}" $ARGUMENTS`

Show the session state exactly. Add no text.

The words are the words of the `/ste` command of the pi extension:

| Word | Result |
| --- | --- |
| (none) | Toggle enforcement. |
| `on` | Enforce again. |
| `off` | Stop every check for this session. |
| `status` | Report the state, and change nothing. |
| `strict` | Block a reply that breaks a hard rule. |
| `strict off` | Leave strict mode. A write and a commit message still block. |
