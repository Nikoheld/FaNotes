# FaNotes request worker

Node worker (no dependencies) that serves the "Fehler & Wünsche" work requests
(see `docs/work-requests-design.md`). It runs on the agent host, one request at a time:

claim (`picked`) -> `working` -> worktree `request/<id>` from fresh `origin/main` -> `claude -p` headless
-> German progress events -> `pr_open` -> poll CI -> `waiting_for_you` -> owner approves
-> `gh pr merge --merge` (only with green CI) -> verify main (tsc + Android `:core:test :app:compileDebugKotlin`)
-> `merged`; otherwise `failed` with a reason. Cancel (server: `rejected`) kills the child and cleans up.

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
| `FANOTES_MODEL_OVERRIDES` | `~/.config/fanotes-request-worker/models.json`: JSON `{"<request id>": "<model>"}`, overrides the model per request |
| `FANOTES_CLAUDE_BIN`, `FANOTES_GH_BIN` | `claude`, `gh` |
| `FANOTES_CLAUDE_PERMISSION_MODE` / `FANOTES_CLAUDE_ALLOWED_TOOLS` | `acceptEdits` / `Bash,Read,Edit,Write,Glob,Grep` |
| `FANOTES_RULES_PATH` | `/srv/agents/fanotes/.site-redesign-tools/study/RULES.md` |
| `FANOTES_WORKER_STATE_FILE` | `<worktree root>/.worker/state.json` |
| `FANOTES_POLL_IDLE_SEC`, `FANOTES_POLL_WAIT_SEC`, `FANOTES_EVENT_THROTTLE_MS` | `15`, `20`, `3000` |
| `FANOTES_CI_TIMEOUT_MIN`, `FANOTES_APPROVAL_TIMEOUT_HOURS` | `45`, `72` |
| `FANOTES_VERIFY=0` | skip the post-merge verification |

Flags: `--once` (exit after one request), `--dry-run` (no node_modules linking, no verification; use with fake binaries).

## Server API (fanotes-site/work-requests-api.mjs)

Worker routes live under `/api/v1/worker`, `Authorization: Bearer <FANOTES_AGENT_TOKEN>`:

- `POST /claim` -> `{request, busy}`; the server already sets `picked`. It refuses (`busy: true`) while another request is `picked`/`working`; `pr_open` and `waiting_for_you` requests do not block.
- `POST /requests/:id/events` `{text, percent}`; `POST /requests/:id/status` `{status, prNumber, prUrl, ci: pending|success|failure, reason}`
- `GET /requests/:id/messages?after=<seq>` -> `{messages:[{seq,text}], status, approved, cancelled, lastSeq}`
- `GET /requests/:id/attachments/(screenshot|logs)` (saved to the worktree's `.request-scratch/`)

Status flow used: `picked` (claim) -> `working` -> `pr_open` (with PR number) -> `waiting_for_you` (CI green) -> `merged` (only after the owner approved) or `failed` with a reason. Follow-ups and CI-fix runs go back to `working`.
Owner cancel moves the request to `rejected` on the server; the worker then kills Claude, cleans up and posts nothing more (the transition is already terminal).
Because requests in `pr_open`/`waiting_for_you` do not block the next claim, the worker serves them concurrently (one job each: CI watch, messages, approval, merge) while at most one job runs Claude.
`api.mjs` is the only place that knows the wire format.

## Behaviour notes

- Follow-up messages that arrive while Claude works or while waiting for approval are appended to
  `.request-scratch/NOTES.md` in the worktree and passed to the next run through `claude --resume <session>`.
  The scratch dir is excluded from git; attachments are saved there too.
- CI red: Claude gets up to two fix runs, then `failed`.
- State (all jobs) is written atomically to the state file after each transition. After a crash or restart the worker resumes
  every job (reusing the worktree and the session id). On SIGTERM it stops without failing the request.
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
and end-to-end dry runs against a fake server, a fake `claude`, a fake `gh` and a temporary git repo (happy path, cancel, no PR, follow-up, red CI, crash recovery), plus `integration.test.mjs`, which runs the worker against the real server module in-process.

## Repairs

- A PR that conflicts with main (GitHub runs no checks then) goes back to Claude with a "merge main, resolve, push" message, up to 3 times, before and at merge time.
- The Android check after the merge runs Gradle `--offline`, so a network drop cannot fail it.
- PR merged by hand after the worker gave up: `node scripts/request-worker/mark-merged.mjs <requestId>:<prNumber> ...` (same env as the worker). It checks with gh that the PR is merged, then the owner's panel shows "merged".
