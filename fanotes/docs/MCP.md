# Grok connector

FaNotes exposes a remote MCP server so Grok Build, and the custom connector form on grok.com, can read the vault you already sync. The server URL is:

```text
https://fanotes.fasrv.ch/mcp
```

In Grok the connector name is `FaNotes`. Grok Build can also add it with:

```text
grok mcp add --transport http fanotes https://fanotes.fasrv.ch/mcp
```

## What Grok can read

The tools are read-only:

- notes (list, read, search)
- exam dates from the calendar, from homework whose title is an exam, and from note lines that name a Klausur, Prüfung or exam
- the rest of the calendar, including calendars hidden in the app
- homework and appointments
- flashcards

Handwriting images, PDF bytes and the `.fanotes` internals are not returned.

## Who can read

Nobody, until both of these are true:

1. On this device, Settings → Sync → Grok-Connector is on. Turning it on asks for the sync password. The password is turned into the usual authentication key on the device. The server stores only a scrypt hash of a separate reader key that stays in the same protected store as the sync session.
2. You approve that exact Grok in the browser. Grok Build and grok.com are the only redirects that can be registered: the grok.com connector callback, and a loopback `http://127.0.0.1` / `localhost` callback for Grok Build (any port, fixed callback path). Approval is an OAuth 2.1 authorization-code grant with PKCE S256. There is no client secret and no password grant.

Access tokens last 15 minutes and name the grant. Refresh tokens rotate. Presenting a replaced refresh token revokes that Grok. Changing the sync password or deleting the account revokes every grant. Switching the connector off does the same. A stolen sync session cannot turn the connector on, because that takes the password again. A stolen reader key can answer tool calls, but it cannot decrypt the vault by itself and it is not in the sync ciphertext.

## What the server stores

The sync store is unchanged: ciphertext, random file ids, and the wrapped vault key. The connector store (`FANOTES_MCP_DIR`, default `/var/lib/fanotes-mcp`) keeps OAuth clients, reader hashes and grant hashes. Tool arguments and note text live in memory only until Grok collects the answer, then they are dropped. If FaNotes is not open on a device that has the connector turned on, the tool returns that fact and no note text.

Design of the encrypted vault: `SYNC.md`.

# Local server (any MCP client)

The desktop app (Windows, Linux) ships a second, separate MCP server for AI programs on the same computer: Claude Desktop, Claude Code, Cursor, ChatGPT desktop, Grok Build and anything else that speaks MCP. Unlike the Grok connector above it needs no account, no sync and no OAuth. It reads the vault folder straight from disk, so it also answers while FaNotes is closed (stdio). The remote connector is unchanged.

It is off by default. Turn it on under Settings → KI-Zugriff (MCP). The settings page also shows copy-paste configuration for your installation.

## Starting it

- stdio, packaged app: `ELECTRON_RUN_AS_NODE=1 <FaNotes executable> <install dir>/resources/app.asar/electron/fanotes-mcp.cjs`. Settings shows the exact command and paths.
- stdio, AppImage (Linux): FaNotes copies the server files to `<app data>/mcp/` (`~/.config/FaNotes/mcp/`) each time Settings is opened, and Settings then shows `ELECTRON_RUN_AS_NODE=1 <FaNotes.AppImage> <app data>/mcp/fanotes-mcp.cjs`. This runs as plain Node: no display, no sandbox flags, so it also works over SSH or in a container (FUSE 2 is still needed to run an AppImage, or use `--appimage-extract-and-run`). Open Settings once after installing or updating so the copy exists. The fallback `<FaNotes.AppImage> --mcp` starts the whole Electron app and needs a display session (`DISPLAY`).
- stdio, from a checkout: `node electron/fanotes-mcp.cjs`.
- Streamable HTTP: Settings → KI-Zugriff (MCP) → Lokalen HTTP-Server starten. The server listens on `http://127.0.0.1:<port>/mcp` while FaNotes is open and needs `Authorization: Bearer <token>`. The port and token are stored in `mcp-local.json` in the app data folder (file mode 0600) and can be regenerated in Settings.

Examples:

```json
{ "mcpServers": { "fanotes": { "command": "/path/to/FaNotes", "args": ["/path/to/resources/app.asar/electron/fanotes-mcp.cjs"], "env": { "ELECTRON_RUN_AS_NODE": "1" } } } }
```

```text
claude mcp add --scope user -e ELECTRON_RUN_AS_NODE=1 fanotes -- /path/to/FaNotes /path/to/resources/app.asar/electron/fanotes-mcp.cjs
claude mcp add --transport http fanotes http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <token>"
```

`--user-data <dir>` (or `FANOTES_USER_DATA`) selects another app data folder. The server re-reads the settings on every request, so the toggles apply at once and no restart of the server is needed. The read tools are always listed (while the feature is off, calls answer that AI access is switched off), so a client that connected early still discovers them. Write tools appear when write access is turned on; the stdio server checks `config.json` every 2 seconds and sends `notifications/tools/list_changed`, which clients that support it pick up. Others need a reconnect to see the write tools. The HTTP transport is stateless and cannot push that notification.

Client config files: Claude Desktop reads `claude_desktop_config.json` (Windows `%APPDATA%\Claude\`, the Microsoft Store build uses a folder under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`, macOS `~/Library/Application Support/Claude/`, Linux `~/.config/Claude/`); restart Claude Desktop after editing it. That file takes stdio entries only; the HTTP JSON is for Cursor, Claude Code and similar. If the app data folder is not the default (`~/.config/FaNotes`, `%APPDATA%\FaNotes`), add `"--user-data", "<path>"` to `args`, because most clients do not forward `XDG_CONFIG_HOME`.

Parallel calls queue (8 run at once, 64 may wait up to 30 seconds); beyond that a tool call returns an error result asking the client to retry. Tool results are capped at about 60,000 characters; a larger result is returned as `{"truncated": true, ...}`. `resources/list` pages with `nextCursor`.

## Tools

Read-only: `vault_stats`, `list_folders` (subjects are the top-level folders), `list_notes` (folder, modifiedSince, kind), `read_note`, `search_notes` (German-aware, all words must match; Markdown, handwriting text, PDF page text, stories), `list_tasks` (homework and appointments), `list_calendar`, `list_exams`, `list_flashcard_decks`, `list_flashcards`, `list_stories`, `read_story` (outline, scene text, characters, places, events), `recent_activity`.

Write tools exist only while Settings → Schreibzugriff is on; otherwise they are not listed and calls are refused: `create_note`, `append_to_note`, `add_task`, `complete_task`.

Resources: every note is available as `fanotes://note/<path>`. Prompts: `weekly_overview`, `summarize_note`. Supported protocol versions: 2025-11-25, 2025-06-18, 2025-03-26, 2024-11-05.

## Where the data comes from

The vault path and the MCP settings come from the app's `config.json`; the secrets in it are never read. Notes are `.md` / `.markdown` files, handwriting notes are `.famd` (the recognized text and text fields, never the ink), PDFs return the page text stored in `.fanotes/page-text/` (never bytes), stories are `*.story` folders (`story.json`, `scenes/`, `bible/`). Tasks come from `Hausaufgaben.md`, events from `Kalender.md` (hidden calendars included, repeating events expanded) and flashcards from the cards block or the "Lernfragen" section of a note. The parsers in `electron/local-mcp-vault.cjs` mirror the renderer's; `npm run check:local-mcp` writes those files with the app's own serializers.

## Security

- stdio serves only the process that launched it. HTTP binds 127.0.0.1 only, compares the bearer token in constant time, rejects any `Host` that is not a loopback name on the bound port (DNS rebinding) and any browser `Origin` that is not loopback, accepts only `POST /mcp` with `application/json` up to 1 MiB, times requests out, and answers 429 after 20 failed attempts per minute.
- Paths are vault-relative with no `..`, no absolute or backslash form and no segment starting with `.` (so `.fanotes` and `.git` are unreachable). The real path of every file must stay inside the real vault root, and symbolic links are skipped.
- Excluded folders (one per line in Settings) are invisible to listing, reading, search, resources and writes.
- Only text is returned. Embedded base64 files are replaced by a placeholder; the machine blocks of the calendar, task list and cards are removed from note text.
- Writes are limited to Markdown notes. New files are published atomically and never replace an existing file; appends and task changes write a temporary file in the same folder and rename it only if the target still has the size, modification time and inode that were read, otherwise nothing is written. A damaged `Hausaufgaben.md` is never rewritten. `Kalender.md`, stories and `.famd` notes are not writable. Because changes are ordinary file writes, the sync engine and the file watcher pick them up like edits from another program. Temporary files start with a dot, so they are not synced.
- Note contents are never logged. Set `FANOTES_MCP_LOG=1` to log tool names and outcomes to stderr.
