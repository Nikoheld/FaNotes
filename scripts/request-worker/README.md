# FaNotes request worker

Node worker (no dependencies) that serves the "Fehler & Wünsche" work requests
(see `docs/work-requests-design.md`). It runs on the agent host, one request at a time:

claim -> `picked` -> worktree `request/<id>` from fresh `origin/main` -> `claude -p` headless
-> German progress events -> `pr_open` -> poll CI -> `waiting_for_you` -> owner approves
-> `gh pr merge --merge` (only with green CI) -> verify main (tsc + Android `:core:test :app:compileDebugKotlin`)
-> `merged`; otherwise `failed` with a reason. Cancel kills the child and posts `failed: abgebrochen`.

Hard rules given to Claude: open a PR, never merge, never push to main, never deploy/release, no secrets.
The agent token is read from the environment only, redacted in logs, and removed from the child environment.

## Configuration (environment)

| Variable | Default |
| --- | --- |
| `FANOTES_SERVER_ORIGIN` | required, e.g. `https://...` |
| `FANOTES_AGENT_TOKEN` | required, environment only |
| `FANOTES_REPO_PATH` | `/srv/agents/fanotes/chats/writing-mode/repo` |
| `FANOTES_WORKTREE_ROOT` | `/srv/agents/fanotes/chats/requests` |
| `FANOTES_REQUEST_BUDGET_MIN` | `60` (whole request, then killed and `failed`) |
| `FANOTES_MAX_TURNS` | unset (passed as `--max-turns`) |
| `FANOTES_CLAUDE_MODEL` | unset (passed as `--model`) |
| `FANOTES_CLAUDE_BIN`, `FANOTES_GH_BIN` | `claude`, `gh` |
| `FANOTES_CLAUDE_PERMISSION_MODE` / `FANOTES_CLAUDE_ALLOWED_TOOLS` | `acceptEdits` / `Bash,Read,Edit,Write,Glob,Grep` |
| `FANOTES_RULES_PATH` | `/srv/agents/fanotes/.site-redesign-tools/study/RULES.md` |
| `FANOTES_WORKER_STATE_FILE` | `<worktree root>/.worker/state.json` |
| `FANOTES_POLL_IDLE_SEC`, `FANOTES_POLL_WAIT_SEC`, `FANOTES_EVENT_THROTTLE_MS` | `15`, `20`, `3000` |
| `FANOTES_CI_TIMEOUT_MIN`, `FANOTES_APPROVAL_TIMEOUT_HOURS` | `45`, `72` |
| `FANOTES_VERIFY=0` | skip the post-merge verification |

Flags: `--once` (exit after one request), `--dry-run` (no node_modules linking, no verification; use with fake binaries).

## Server API assumed

All under `/api/v1/requests`, `Authorization: Bearer <token>`:

- `POST /worker/claim` -> `{request: {id, type: "bug"|"feature", title, description, priority, attachments: [{name, mime, dataBase64 | text}], messages: [{id, text}]}}` or `{request: null}` / 204
- `POST /worker/requests/:id/events` body `{type: "progress", text, percent}`
- `POST /worker/requests/:id/status` body `{status: picked|working|pr_open|waiting_for_you|merged|failed, prNumber?, prUrl?, ci?: pending|green|red, reason?}`
- `GET /worker/requests/:id/messages` -> `{status, approved?, cancelled?, messages: [{id, from: "owner", text}]}`. Approval is `approved: true` or `status: "approved"`; cancel is `cancelled: true`, `cancelRequested: true` or `status: "cancelled"`; `status: "rejected"` stops the work without merging.

`api.mjs` (`parseControl`) is the single place to adapt if the server differs.

## Behaviour notes

- Follow-up messages that arrive while Claude works or while waiting for approval are appended to
  `.request-scratch/NOTES.md` in the worktree and passed to the next run through `claude --resume <session>`.
  The scratch dir is excluded from git; attachments are saved there too.
- CI red: Claude gets up to two fix runs, then `failed`.
- State is written atomically to the state file after each transition. After a crash or restart the worker resumes
  the same request (reusing the worktree and the session id). On SIGTERM it stops without failing the request.
- Worktrees are removed after merge or failure; the local branch is deleted only after a merge.
- The prompt is sent via stdin to `claude -p` (same as passing it as argument, but not visible in `ps`).

## Install (do not do this before the owner approves)

1. Store the token: `printf '%s' '<token>' | agent-vault set fanotes-agent-token` (same value as the server's `FANOTES_AGENT_TOKEN`).
2. `mkdir -p ~/.config/fanotes-request-worker && cp scripts/request-worker/env.example ~/.config/fanotes-request-worker/env && chmod 600 ~/.config/fanotes-request-worker/env`, then edit the origin.
3. `cp scripts/request-worker/fanotes-request-worker.service ~/.config/systemd/user/` and adjust paths.
4. `systemctl --user daemon-reload && systemctl --user enable --now fanotes-request-worker`
5. Logs: `journalctl --user -u fanotes-request-worker -f`.

Make sure `claude` and `gh` are authenticated for the service user and that `loginctl enable-linger` is set if it should run without a session.

## Tests

`node --test scripts/request-worker/test/*.test.mjs` covers the stream-json to progress mapping, the state machine, config/prompt/CLI args,
and end-to-end dry runs against a fake server, a fake `claude`, a fake `gh` and a temporary git repo (happy path, cancel, no PR, follow-up, red CI, crash recovery).
