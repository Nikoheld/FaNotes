# Working on FaNotes / Kanti+

## Which model does what (token saving)
- **Opus (main session):** planning, architecture, specs, hard debugging, reviewing subagent results, merging, releasing, deploying the server part.
- **`implementer` subagent (Sonnet, `.claude/agents/implementer.md`):** implementing well-specified features and UI, writing tests, refactors. Give it a written spec, the worktree/branch, and the test commands.
- **`explorer` subagent (Haiku, `.claude/agents/explorer.md`):** searching and reading the codebase, grep/explore, reading logs, checking builds and CI, changelogs and release notes, trivial fixes.
- Default to the cheapest agent that can do the job; escalate to Opus only for design decisions or when a cheaper agent got stuck.

## Standing rules
- Schulnetz is strictly read-only (GET only).
- Every Kanti+ release also deploys and verifies the matching `fanotes-site` server part and the schulnetz.fasrv.ch web app.
- The 10-minute grade push promise must hold (see `fanotes-site/grade-sla.test.mjs`).
