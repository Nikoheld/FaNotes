# FaNotes release policy

FaNotes uses calendar versions from July 2026 onward.

## Version names

- Stable: `YYYY.M.N`, for example `2026.7.1`
- Beta: `YYYY.M.N-beta.B`, for example `2026.7.2-beta.3`
- `N` is the consecutive stable release number within the month (`1`, `2`, …).
- `B` is the consecutive beta build for the targeted stable release.

The month is written without a leading zero inside `package.json` so the value remains valid SemVer for npm and Electron. The UI may render the month padded (`2026.07.1`) when a calendar-style display is useful.

## Channels

Stable receives only stable releases. Beta receives stable releases plus newer prereleases. GitHub releases for beta builds must set `prerelease: true`; stable releases must set it to `false` and may become GitHub's latest release.

Switching from Beta to Stable never installs an older build. A user who is ahead of Stable remains on the installed beta until a newer stable release exists.

## Stable cadence

- Target: two meaningful stable releases per calendar month.
- There is no monthly maximum. Extra stables in the same month are normal when they ship a coherent, useful package.
- A stable release normally follows a tested beta cohort and bundles multiple user-visible improvements or an important security/reliability correction.
- If a month has too few large features, a later stable can bundle accumulated quality, compatibility, translation, efficiency and recognition improvements.

The maintainer decides when a beta cohort is promoted after reviewing the changelog and the full verification evidence. Passing a narrow test is not by itself a promotion decision.

## Required publication

GitHub Actions builds every app when the version tag is pushed. The server does not package Linux, Windows, or Android. Desktop auto-update reads the signed manifest and the packages from that GitHub release. Vault sync stays on `fanotes.fasrv.ch`. There is no macOS package.

## Updating the version

Run **Update version** from the Actions tab. Give it a calendar version such as `2026.10.7` and one changelog line per change. The workflow writes that version into `fanotes/package.json`, the lockfile, the Tauri config, and the Android app, commits it on `main`, tags `v<version>`, and builds the GitHub release. Leave “Publish the release” off to only update the files.

Run **Alpha** from the Actions tab, on `main`, when the merged branch should become the next beta. Alpha asks for no inputs. It reads every non-merge commit since the previous tag, chooses the next `YYYY.M.N-beta.B` for this month, commits that version on `main`, and builds the same Linux, Windows, and Android packages as a stable release. The GitHub release is a prerelease, so it does not replace Latest. Desktop beta manifests are named `FaNotes-update-linux-x64-beta.json` and `FaNotes-update-windows-x64-beta.json`. The Stable channel keeps reading the latest stable release. Android is signed with the stable FaNotes key. Alpha does nothing when `main` has no commits after the previous tag.

Every release must include:

1. Linux AppImage and portable tar archive.
2. Windows installer and portable executable.
3. The Android APK.
4. `SHA256SUMS` and the signed Linux and Windows update manifests, attached to the GitHub release.
5. A GitHub tag and release; beta releases are GitHub prereleases.

Differential packages are optional. When the manifest has no delta, the app downloads the full package from GitHub and checks its SHA-256 and signature. Copies older than 2026.10.6 still ask the server feed, so that one release is also published there and later updates come from GitHub.

Private signing keys, API keys, user vaults, analytics, backups, dependency folders and temporary build output are never publication artifacts.

Run `npm run release:policy -- --version <version>` before preparing a release. The publisher is resumable and must verify GitHub asset sizes after upload.
