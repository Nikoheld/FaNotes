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
