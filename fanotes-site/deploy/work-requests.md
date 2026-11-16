# Work requests server (deploy notes, not yet deployed)

API: `work-requests-api.mjs`, mounted in `server.mjs`. Design: "Fehler & Wünsche" work requests.

## Environment (site service)
| Variable | Meaning |
| --- | --- |
| `FANOTES_REQUEST_OWNERS` | Comma list of sync account ids allowed to use the feature. Empty or unset = feature off (`GET /api/v1/requests/capabilities` returns `{"enabled":false}`, all owner endpoints answer 403). |
| `FANOTES_AGENT_TOKEN` | Bearer token for `/api/v1/worker/*` (at least 32 random characters). Unset = worker endpoints answer 503. Keep the value in agent-vault, never in the repo, a unit file in git or chat. Generate with `openssl rand -base64 36 \| tr '+/' '-_'`. |
| `FANOTES_REQUESTS_DIR` | Data directory, default `/var/lib/fanotes-requests`. |

Add them through a drop-in under `fanotes-site.service.d/` (mode 0600, outside git) or the existing `EnvironmentFile`. The worker reads the same token from agent-vault.

## Data directory
Create `/var/lib/fanotes-requests` owned by the site service user, mode 0700 (the server also creates `requests/`, `events/`, `attachments/` with 0700 and files with 0600). Add the path to `ReadWritePaths=` if the unit sandboxes the file system. Layout: `requests/<id>.json`, `events/<id>.jsonl`, `attachments/<id>/{screenshot,logs}`. Include it in backups only if wanted; it holds scrubbed logs and screenshots.

## nginx
`fanotes-fasrv.conf` has `location ^~ /api/v1/requests` (SSE: buffering off, 120 s read timeout, 3.7 MB bodies) and `location ^~ /api/v1/worker/`. Reload nginx after copying it.

## Behaviour worth knowing
- Owner auth is the sync session (`Authorization: Bearer <session>` + `X-FaNotes-Account`); the account id must be in the allow-list. SSE clients therefore need a fetch-based reader (EventSource cannot send headers). Reconnect with `Last-Event-ID`; the stream ends after a terminal status.
- Claim hands out the oldest queued request and refuses while another request is `picked` or `working` (`{"request":null,"busy":true}`). Requests in `pr_open`/`waiting_for_you` do not block the next claim; the worker must keep serving them (watch CI, poll messages, merge after `approved`).
- Limits: 10 creates/h and 60 messages/h per account, 20 open requests per account, 500 stored requests, 20 SSE streams (5 per account), screenshot 2 MB (PNG/JPEG, magic bytes checked), logs 256 KB (scrubbed line by line with the diagnostics scrubber).
- `merged` is only accepted after the owner called `approve` while the request was `waiting_for_you`.
