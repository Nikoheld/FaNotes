# FaNotes release policy

FaNotes uses calendar versions from July 2026 onward.

## Version names

- Stable: `YYYY.M.N`, for example `2026.7.1`
- Beta: `YYYY.M.N-beta.B`, for example `2026.7.2-beta.3`
- `N` is the stable release number within the month and is limited to `1`–`4`.
- `B` is the consecutive beta build for the targeted stable release.

The month is written without a leading zero inside `package.json` so the value remains valid SemVer for npm and Electron. The UI may render the month padded (`2026.07.1`) when a calendar-style display is useful.

## Channels

Stable receives only stable releases. Beta receives stable releases plus newer prereleases. GitHub releases for beta builds must set `prerelease: true`; stable releases must set it to `false` and may become GitHub's latest release.

Switching from Beta to Stable never installs an older build. A user who is ahead of Stable remains on the installed beta until a newer stable release exists.

## Stable cadence

- Target: two meaningful stable releases per calendar month.
- Maximum: four stable releases per calendar month.
- A stable release normally follows a tested beta cohort and bundles multiple user-visible improvements or an important security/reliability correction.
- If a month has too few large features, the second stable release bundles accumulated quality, compatibility, translation, efficiency and recognition improvements instead of publishing one-change stable builds.
- A third or fourth stable release requires a sufficiently valuable bundle or an urgent correctness/security reason.

The maintainer decides when a beta cohort is promoted after reviewing the changelog and the full verification evidence. Passing a narrow test is not by itself a promotion decision.

## Required publication

Every release must include:

1. Linux AppImage and portable tar archive.
2. Windows installer, blockmap and portable executable.
3. Linux and Windows application ASAR files used by differential updates.
4. Incoming Linux and Windows delta packages when a compatible base exists.
5. SHA-256 checksums, changelog, installation guides, license and third-party notices.
6. A GitHub tag and release; beta releases are GitHub prereleases.
7. The signed Stable/Beta update manifests on `fanotes.fasrv.ch`.

Private signing keys, API keys, user vaults, analytics, backups, dependency folders and temporary build output are never publication artifacts.

Run `npm run release:policy -- --version <version>` before preparing a release. The publisher is resumable and must verify GitHub asset sizes after upload.
