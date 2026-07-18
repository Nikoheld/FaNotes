#!/usr/bin/env python3
"""Publish the complete FaNotes changelog and available installers to GitHub.

The publisher is intentionally resumable. Existing releases and byte-identical
assets are skipped, while incomplete or size-mismatched assets are replaced.
The GitHub token is read without echoing it and never appears in command-line
arguments or logs.
"""

from __future__ import annotations

import getpass
import hashlib
import http.client
import json
import mimetypes
import os
from pathlib import Path
import re
import sys
import tempfile
import time
from typing import Any
from urllib.parse import quote, urlsplit


OWNER = "Nikoheld"
REPOSITORY = "FaNotes"
API_HOST = "api.github.com"
CHANGELOG = Path(os.environ.get("FANOTES_RELEASE_DIR", "/mnt/truenas/Fabio/FaNotes-Arch-x86_64")) / "CHANGELOG.md"
RELEASE_DIR = CHANGELOG.parent
TRANSLATIONS = Path(__file__).resolve().parents[2] / "fanotes-site/public/i18n/en.json"
API_VERSION = "2022-11-28"
CHUNK_SIZE = 8 * 1024 * 1024
MAX_RETRIES = 5
VERSION_PATTERN = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$")
COMMON_RELEASE_FILES = (
    "CHANGELOG.md",
    "README.md",
    "INSTALL_ARCH.md",
    "INSTALL_WINDOWS.md",
    "PKGBUILD",
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "LICENSE-OFL-1.1.txt",
    "LICENSE-ONNXRUNTIME-MIT.txt",
    "LICENSE-PYLAIA-MIT.txt",
    "LICENSE-TRANSFORMERS-APACHE-2.0.txt",
    "LICENSE-TROCR-MIT.txt",
    "fanotes.desktop",
    "fanotes.svg",
)


def version_key(version: str) -> tuple[int, int, int, int]:
    match = VERSION_PATTERN.fullmatch(version)
    if not match:
        raise ValueError(f"Invalid FaNotes version: {version}")
    major, minor, patch = (int(match.group(index)) for index in range(1, 4))
    beta = int(match.group(4)) if match.group(4) else 1_000_000_000
    return major, minor, patch, beta


def parse_changelog() -> list[tuple[str, list[str]]]:
    text = CHANGELOG.read_text(encoding="utf-8")
    matches = list(re.finditer(r"^##\s+(\d+\.\d+\.\d+(?:-beta\.\d+)?)\s*$", text, re.MULTILINE))
    releases: list[tuple[str, list[str]]] = []
    for index, match in enumerate(matches):
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        notes = [
            item.group(1).strip()
            for item in re.finditer(r"^-\s+(.+)$", text[match.end():end], re.MULTILINE)
        ]
        releases.append((match.group(1), notes))
    return sorted(releases, key=lambda item: version_key(item[0]))


def release_body(version: str, notes: list[str], translations: dict[str, str]) -> str:
    german = "\n".join(f"- {note}" for note in notes) or "- Historische FaNotes-Version."
    english_notes = [translations.get(note, note) for note in notes]
    english = "\n".join(f"- {note}" for note in english_notes) or "- Historical FaNotes release."
    downloads = (
        "Installationspakete sind angehängt, sofern die ursprünglichen Binärdateien noch "
        "im Release-Archiv vorhanden sind. / Installation packages are attached where "
        "the original binaries are still available in the release archive."
    )
    return f"## Deutsch\n\n{german}\n\n## English\n\n{english}\n\n---\n\n{downloads}\n"


class GitHub:
    def __init__(self, token: str) -> None:
        self.token = token

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {self.token}",
            "User-Agent": "FaNotes-release-publisher/1.0",
            "X-GitHub-Api-Version": API_VERSION,
        }

    def request(
        self,
        method: str,
        path: str,
        payload: dict[str, Any] | None = None,
        expected: tuple[int, ...] = (200,),
    ) -> Any:
        body = None if payload is None else json.dumps(payload).encode("utf-8")
        headers = dict(self.headers)
        if body is not None:
            headers["Content-Type"] = "application/json"
            headers["Content-Length"] = str(len(body))
        for attempt in range(MAX_RETRIES):
            connection = http.client.HTTPSConnection(API_HOST, timeout=120)
            try:
                connection.request(method, path, body=body, headers=headers)
                response = connection.getresponse()
                data = response.read()
                if response.status in expected:
                    return json.loads(data) if data else None
                if response.status in (429, 500, 502, 503, 504) and attempt + 1 < MAX_RETRIES:
                    time.sleep(2 ** attempt)
                    continue
                detail = data.decode("utf-8", errors="replace")[:2000]
                raise RuntimeError(f"GitHub API {method} {path}: HTTP {response.status}: {detail}")
            finally:
                connection.close()
        raise RuntimeError(f"GitHub API {method} {path}: retry limit reached")

    def upload(self, upload_url: str, file_path: Path, asset_name: str) -> dict[str, Any]:
        parsed = urlsplit(upload_url.split("{")[0])
        path = f"{parsed.path}?name={quote(asset_name)}"
        mime = mimetypes.guess_type(asset_name)[0] or "application/octet-stream"
        size = file_path.stat().st_size
        headers = dict(self.headers)
        headers.update({"Content-Type": mime, "Content-Length": str(size)})

        for attempt in range(MAX_RETRIES):
            connection = http.client.HTTPSConnection(parsed.netloc, timeout=7200)
            try:
                connection.putrequest("POST", path)
                for key, value in headers.items():
                    connection.putheader(key, value)
                connection.endheaders()
                sent = 0
                next_report = 256 * 1024 * 1024
                with file_path.open("rb", buffering=CHUNK_SIZE) as source:
                    while chunk := source.read(CHUNK_SIZE):
                        connection.send(chunk)
                        sent += len(chunk)
                        if sent >= next_report:
                            print(
                                f"    {asset_name}: {sent / 1024 / 1024:.0f} / "
                                f"{size / 1024 / 1024:.0f} MiB",
                                flush=True,
                            )
                            next_report += 256 * 1024 * 1024
                response = connection.getresponse()
                data = response.read()
                if response.status == 201:
                    return json.loads(data)
                if response.status in (429, 500, 502, 503, 504) and attempt + 1 < MAX_RETRIES:
                    print(f"    Upload retry {attempt + 1}: HTTP {response.status}", flush=True)
                    time.sleep(2 ** attempt)
                    continue
                detail = data.decode("utf-8", errors="replace")[:2000]
                raise RuntimeError(f"GitHub upload {asset_name}: HTTP {response.status}: {detail}")
            finally:
                connection.close()
        raise RuntimeError(f"GitHub upload {asset_name}: retry limit reached")


def assets_for(version: str, include_all_files: bool) -> list[Path]:
    names = (
        f"FaNotes-{version}-x86_64.AppImage",
        f"FaNotes-{version}-x86_64.tar.gz",
        f"FaNotes-Setup-{version}-x64.exe",
        f"FaNotes-Setup-{version}-x64.exe.blockmap",
        f"FaNotes-Portable-{version}-x64.exe",
    )
    assets = [RELEASE_DIR / name for name in names if (RELEASE_DIR / name).is_file()]
    if not include_all_files:
        return assets
    extra_names = (
        f"app-{version}-linux.asar",
        f"app-{version}-windows.asar",
        *COMMON_RELEASE_FILES,
    )
    assets.extend(RELEASE_DIR / name for name in extra_names if (RELEASE_DIR / name).is_file())
    assets.extend(sorted(
        path for path in RELEASE_DIR.glob(f"FaNotes-Delta-*-to-{version}.fndelta") if path.is_file()
    ))
    unique: dict[str, Path] = {}
    for path in assets:
        unique[path.name] = path
    return list(unique.values())


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb", buffering=CHUNK_SIZE) as source:
        while chunk := source.read(CHUNK_SIZE):
            digest.update(chunk)
    return digest.hexdigest()


def checksum_asset(version: str, assets: list[Path], target_dir: Path) -> tuple[Path, dict[str, str]]:
    target = target_dir / f"SHA256SUMS-{version}.txt"
    digests = {path.name: sha256(path) for path in assets}
    target.write_text(
        "".join(f"{digests[path.name]}  {path.name}\n" for path in assets),
        encoding="utf-8",
    )
    digests[target.name] = sha256(target)
    return target, digests


def main() -> int:
    requested_version = None
    if len(sys.argv) > 1:
        if len(sys.argv) != 3 or sys.argv[1] != "--version":
            raise RuntimeError("Usage: publish-github-releases.py [--version VERSION]")
        requested_version = sys.argv[2]
        if not VERSION_PATTERN.fullmatch(requested_version):
            raise RuntimeError("The requested release version is invalid.")
    token = os.environ.get("GITHUB_TOKEN") or getpass.getpass("GitHub token: ")
    if not token:
        raise RuntimeError("A GitHub token is required.")
    github = GitHub(token)
    user = github.request("GET", "/user")
    if user.get("login") != OWNER:
        raise RuntimeError(f"Authenticated as {user.get('login')!r}, expected {OWNER!r}.")
    repository = github.request("GET", f"/repos/{OWNER}/{REPOSITORY}")
    permissions = repository.get("permissions") or {}
    if not permissions.get("push"):
        raise RuntimeError("The token does not have write access to Nikoheld/FaNotes.")
    print(f"Authenticated as {user['login']}; repository write access confirmed.", flush=True)

    translations = json.loads(TRANSLATIONS.read_text(encoding="utf-8"))
    changelog = parse_changelog()
    if requested_version:
        changelog = [release for release in changelog if release[0] == requested_version]
        if not changelog:
            raise RuntimeError(f"CHANGELOG.md has no release section for {requested_version}.")
    all_changelog = parse_changelog()
    stable_versions = [version for version, _notes in all_changelog if "-beta." not in version]
    latest_stable_version = max(stable_versions, key=version_key)
    existing = github.request("GET", f"/repos/{OWNER}/{REPOSITORY}/releases?per_page=100")
    by_tag = {release["tag_name"]: release for release in existing}
    releases_to_publish: set[str] = set()
    expected_assets_by_tag: dict[str, dict[str, tuple[int, str]]] = {}

    for version, notes in changelog:
        tag = f"v{version}"
        body = release_body(version, notes, translations)
        prerelease = "-beta." in version
        # A new targeted publication must never expose a release whose assets
        # are still being uploaded. An interrupted draft remains a draft on the
        # next run. A release which is already public must not be converted back
        # to a draft: GitHub can detach its tag when that draft is republished.
        publish_atomically = requested_version is not None
        release = by_tag.get(tag)
        if release is None:
            release = github.request(
                "POST",
                f"/repos/{OWNER}/{REPOSITORY}/releases",
                {
                    "tag_name": tag,
                    "target_commitish": repository["default_branch"],
                    "name": f"FaNotes {version}",
                    "body": body,
                    "draft": publish_atomically,
                    "prerelease": prerelease,
                    "make_latest": "false" if prerelease else ("true" if version == latest_stable_version else "false"),
                },
                expected=(201,),
            )
            if publish_atomically:
                releases_to_publish.add(tag)
            print(f"Created release {tag}.", flush=True)
        else:
            keep_as_draft = publish_atomically and bool(release.get("draft"))
            patch: dict[str, Any] = {
                "name": f"FaNotes {version}",
                "body": body,
                "draft": keep_as_draft,
                "prerelease": prerelease,
                "make_latest": "false" if prerelease else ("true" if version == latest_stable_version else "false"),
            }
            release = github.request(
                "PATCH",
                f"/repos/{OWNER}/{REPOSITORY}/releases/{release['id']}",
                patch,
            )
            if keep_as_draft:
                releases_to_publish.add(tag)
            print(f"Updated release {tag}.", flush=True)
        by_tag[tag] = release

    with tempfile.TemporaryDirectory(prefix="fanotes-github-releases-") as temp:
        temp_dir = Path(temp)
        for version, _notes in changelog:
            assets = assets_for(version, include_all_files=requested_version is not None)
            if not assets:
                continue
            checksum_path, asset_digests = checksum_asset(version, assets, temp_dir)
            assets.append(checksum_path)
            tag = f"v{version}"
            expected_assets_by_tag[tag] = {
                path.name: (path.stat().st_size, asset_digests[path.name]) for path in assets
            }
            release = by_tag[tag]
            current_assets = {asset["name"]: asset for asset in release.get("assets", [])}
            print(f"Assets for v{version}: {len(assets)} files.", flush=True)
            for path in assets:
                current = current_assets.get(path.name)
                expected_digest = f"sha256:{asset_digests[path.name]}"
                if (
                    current and
                    current.get("state") == "uploaded" and
                    current.get("size") == path.stat().st_size and
                    current.get("digest") == expected_digest
                ):
                    print(f"  Skip {path.name} (already uploaded).", flush=True)
                    continue
                if current:
                    github.request(
                        "DELETE",
                        f"/repos/{OWNER}/{REPOSITORY}/releases/assets/{current['id']}",
                        expected=(204,),
                    )
                print(f"  Upload {path.name} ({path.stat().st_size / 1024 / 1024:.1f} MiB).", flush=True)
                uploaded = github.upload(release["upload_url"], path, path.name)
                if uploaded.get("size") != path.stat().st_size or uploaded.get("state") != "uploaded":
                    raise RuntimeError(f"GitHub did not confirm {path.name} as a complete upload.")

    if releases_to_publish:
        for version, _notes in changelog:
            tag = f"v{version}"
            if tag not in releases_to_publish:
                continue
            prerelease = "-beta." in version
            release = by_tag[tag]
            release = github.request(
                "PATCH",
                f"/repos/{OWNER}/{REPOSITORY}/releases/{release['id']}",
                {
                    "draft": False,
                    "prerelease": prerelease,
                    "make_latest": "false" if prerelease else ("true" if version == latest_stable_version else "false"),
                },
            )
            by_tag[tag] = release
            print(f"Published v{version} after all assets were verified.", flush=True)

    expected_tags = {f"v{version}" for version, _notes in changelog}
    if requested_version is not None:
        for version, _notes in changelog:
            tag = f"v{version}"
            release = github.request("GET", f"/repos/{OWNER}/{REPOSITORY}/releases/tags/{quote(tag, safe='')}")
            if release.get("draft") or bool(release.get("prerelease")) != ("-beta." in version):
                raise RuntimeError(f"GitHub returned an invalid publication state for {tag}.")
            remote_assets = {asset["name"]: asset for asset in release.get("assets", [])}
            for name, (size, digest) in expected_assets_by_tag.get(tag, {}).items():
                asset = remote_assets.get(name)
                if (
                    not asset or
                    asset.get("state") != "uploaded" or
                    asset.get("size") != size or
                    asset.get("digest") != f"sha256:{digest}"
                ):
                    raise RuntimeError(f"GitHub did not preserve the verified asset {name} for {tag}.")
    else:
        final_releases = github.request("GET", f"/repos/{OWNER}/{REPOSITORY}/releases?per_page=100")
        final_tags = {release["tag_name"] for release in final_releases}
        missing = sorted(expected_tags - final_tags)
        if missing:
            raise RuntimeError(f"Missing releases after publication: {', '.join(missing)}")
    print(
        f"Verified {len(expected_tags)} GitHub release(s); latest stable is v{latest_stable_version}.",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        print("Interrupted; rerun the publisher to resume safely.", file=sys.stderr)
        raise SystemExit(130)
