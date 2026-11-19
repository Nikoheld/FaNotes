//! The update flow without the UI shell: check, stage (download or delta),
//! verify. This is `check()`, `download()` and the integrity part of
//! `prepareInstall()` from `createUpdateManager`. Timers, window events and the
//! install helper scripts belong to the host that wires this crate in.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

use crate::delta::{apply_delta_patch, ApplyOptions, ExpectedFile, ExpectedHeader};
use crate::download::{download_transfer, TransferInfo, TransferOptions};
use crate::error::{err, ErrorKind, Result, UpdateError};
use crate::fetch::{fetch_manifest, Fetcher, ManifestRequest};
use crate::manifest::{DeltaInfo, VerifiedManifest, EXPECTED_KEY_ID, PRODUCT_PUBLIC_KEY_PEM};
use crate::platform::Platform;
use crate::state::{make_private_dir, PendingInstall, UpdaterState};
use crate::util::{is_plain_file, lstat_opt, sha256_file};
use crate::version::Channel;

#[derive(Debug, Clone)]
pub struct UpdaterConfig {
    pub platform: Platform,
    pub current_version: String,
    pub channel: Channel,
    pub public_key_pem: String,
    pub expected_key_id: String,
    /// `<userData>/updates`: holds `state.json` and one directory per version.
    pub updater_root: PathBuf,
    /// The file a delta is applied to: the AppImage (Linux) or `resources/app.asar` (Windows).
    /// Must be absolute, otherwise no delta is attempted.
    pub delta_source_path: Option<PathBuf>,
}

impl UpdaterConfig {
    /// Production key and key id.
    pub fn production(
        platform: Platform,
        current_version: &str,
        channel: Channel,
        updater_root: PathBuf,
        delta_source_path: Option<PathBuf>,
    ) -> Self {
        Self {
            platform,
            current_version: current_version.to_owned(),
            channel,
            public_key_pem: PRODUCT_PUBLIC_KEY_PEM.to_owned(),
            expected_key_id: EXPECTED_KEY_ID.to_owned(),
            updater_root,
            delta_source_path,
        }
    }

    pub fn state_path(&self) -> PathBuf {
        self.updater_root.join("state.json")
    }
}

/// A verified file ready to install.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StagedUpdate {
    pub target_path: PathBuf,
    pub used_delta: bool,
    pub file_name: String,
    pub sha256: String,
    pub size_bytes: u64,
    /// Bytes that crossed the network (the patch for a delta, else the package).
    pub transfer_bytes: u64,
    /// Why a delta was abandoned for the signed full package, when it was.
    pub fallback_reason: Option<String>,
}

#[derive(Debug)]
pub enum CheckOutcome {
    /// The offered version is not newer than the installed one.
    UpToDate(VerifiedManifest),
    /// A previously downloaded and re-verified package is still on disk.
    Staged(VerifiedManifest, StagedUpdate),
    Available(VerifiedManifest),
}

pub struct UpdateClient<F: Fetcher> {
    pub config: UpdaterConfig,
    fetcher: F,
    state: UpdaterState,
}

impl<F: Fetcher> UpdateClient<F> {
    /// Loads `state.json` (missing or unreadable means empty).
    pub fn new(config: UpdaterConfig, fetcher: F) -> Self {
        let state = UpdaterState::load(&config.state_path());
        Self {
            config,
            fetcher,
            state,
        }
    }

    pub fn state(&self) -> &UpdaterState {
        &self.state
    }

    fn persist(&self) -> Result<()> {
        self.state.save(&self.config.state_path())
    }

    /// Fetch and verify the manifest for the configured channel, apply the
    /// rollback guard, remember the highest version, and look for a staged package.
    pub fn check(&mut self) -> Result<CheckOutcome> {
        let verified = fetch_manifest(
            &self.fetcher,
            &ManifestRequest {
                platform: self.config.platform,
                current_version: &self.config.current_version,
                channel: self.config.channel,
                public_key_pem: &self.config.public_key_pem,
                expected_key_id: &self.config.expected_key_id,
            },
        )?;
        self.state
            .check_rollback(self.config.channel, &verified.latest_version)?;
        if self
            .state
            .remember_highest(self.config.channel, &verified.latest_version)?
        {
            self.persist()?;
        }
        if !verified.update_available {
            if self.state.pending_install.take().is_some() {
                let _ = self.persist();
            }
            return Ok(CheckOutcome::UpToDate(verified));
        }
        if let Some(staged) = self.try_adopt_staged(&verified) {
            self.remember_pending_install(&verified, &staged)?;
            return Ok(CheckOutcome::Staged(verified, staged));
        }
        let stale = self.state.pending_install.as_ref().is_some_and(|p| {
            p.channel == self.config.channel && p.version == verified.latest_version
        });
        if stale {
            // Staged file vanished or failed verification: drop the stale marker.
            self.state.pending_install = None;
            let _ = self.persist();
        }
        Ok(CheckOutcome::Available(verified))
    }

    fn release_directory(&self, manifest: &VerifiedManifest) -> PathBuf {
        self.config.updater_root.join(&manifest.latest_version)
    }

    fn try_adopt_staged(&self, verified: &VerifiedManifest) -> Option<StagedUpdate> {
        let primary = verified.primary_package(self.config.platform);
        let mut candidates = Vec::new();
        if let Some(delta) = &verified.delta {
            if let Some(name) = &delta.target.file_name {
                candidates.push((
                    name.clone(),
                    delta.target.size_bytes,
                    delta.target.sha256.clone(),
                    true,
                ));
            }
        }
        candidates.push((
            primary.file_name.clone(),
            primary.size_bytes,
            primary.sha256.clone(),
            false,
        ));
        let directory = self.release_directory(verified);
        for (file_name, size_bytes, sha256, used_delta) in candidates {
            let target_path = directory.join(&file_name);
            let Some(existing) =
                lstat_opt(&target_path).filter(|m| is_plain_file(m) && m.len() == size_bytes)
            else {
                continue;
            };
            let _ = existing;
            if sha256_file(&target_path).ok().as_deref() != Some(sha256.as_str()) {
                continue;
            }
            make_executable(&target_path, self.config.platform);
            return Some(StagedUpdate {
                target_path,
                used_delta,
                file_name,
                sha256,
                size_bytes,
                transfer_bytes: size_bytes,
                fallback_reason: None,
            });
        }
        None
    }

    fn remember_pending_install(
        &mut self,
        manifest: &VerifiedManifest,
        staged: &StagedUpdate,
    ) -> Result<()> {
        let _ = manifest;
        self.state.pending_install = Some(PendingInstall {
            channel: self.config.channel,
            version: manifest.latest_version.clone(),
            file_name: staged.file_name.clone(),
            sha256: staged.sha256.clone(),
            size_bytes: staged.size_bytes,
            used_delta: staged.used_delta,
            prepared_at: Some(crate::date::now_iso()),
        });
        self.persist()
    }

    /// `resolveDeltaSource`: the installed file must match the delta's base exactly.
    fn resolve_delta_source(&self, delta: &DeltaInfo) -> Result<PathBuf> {
        let Some(candidate) = self
            .config
            .delta_source_path
            .as_ref()
            .filter(|p| p.is_absolute())
        else {
            return err(ErrorKind::Delta, "Diese FaNotes-Installation besitzt keine sichere lokale Basis für ein differentielles Update.");
        };
        let matches = lstat_opt(candidate)
            .is_some_and(|m| is_plain_file(&m) && m.len() == delta.source.size_bytes);
        if !matches {
            return err(
                ErrorKind::Delta,
                "Die installierte FaNotes-Datei passt nicht zur Basis des differentiellen Updates.",
            );
        }
        if sha256_file(candidate)? != delta.source.sha256 {
            return err(
                ErrorKind::Hash,
                "Die installierte FaNotes-Datei wurde verändert. Das differentielle Update wurde zum Schutz der Installation blockiert.",
            );
        }
        Ok(candidate.clone())
    }

    fn stage_selected(
        &self,
        manifest: &VerifiedManifest,
        selected_delta: Option<(&DeltaInfo, &Path)>,
        cancel: &AtomicBool,
        progress: &mut Option<&mut dyn FnMut(u64, u64)>,
    ) -> Result<StagedUpdate> {
        let platform = self.config.platform;
        let package = manifest.primary_package(platform);
        let directory = self.release_directory(manifest);
        let (transfer, target_name, target_size, target_sha) = match selected_delta {
            Some((delta, _)) => (
                TransferInfo {
                    file_name: delta.file_name.clone(),
                    size_bytes: delta.size_bytes,
                    sha256: delta.sha256.clone(),
                    url: delta.url.clone(),
                },
                delta.target.file_name.clone().unwrap_or_default(),
                delta.target.size_bytes,
                delta.target.sha256.clone(),
            ),
            None => (
                TransferInfo {
                    file_name: package.file_name.clone(),
                    size_bytes: package.size_bytes,
                    sha256: package.sha256.clone(),
                    url: package.url.clone(),
                },
                package.file_name.clone(),
                package.size_bytes,
                package.sha256.clone(),
            ),
        };
        let staged = |target_path: PathBuf| StagedUpdate {
            target_path,
            used_delta: selected_delta.is_some(),
            file_name: target_name.clone(),
            sha256: target_sha.clone(),
            size_bytes: target_size,
            transfer_bytes: transfer.size_bytes,
            fallback_reason: None,
        };
        let target_path = directory.join(&target_name);
        if let Some(existing) = lstat_opt(&target_path) {
            if is_plain_file(&existing)
                && existing.len() == target_size
                && sha256_file(&target_path)? == target_sha
            {
                make_executable(&target_path, platform);
                return Ok(staged(target_path));
            }
            let _ = std::fs::remove_file(&target_path);
        }
        let accept = if selected_delta.is_some() {
            "application/vnd.fanotes.delta, application/octet-stream;q=0.9"
        } else {
            platform.accept()
        };
        let mut options =
            TransferOptions::new(platform, &self.config.current_version, accept, cancel);
        options.progress = progress
            .as_deref_mut()
            .map(|p| p as &mut dyn FnMut(u64, u64));
        let transfer_path = download_transfer(&self.fetcher, &transfer, &directory, options)?;
        if let Some((delta, source_path)) = selected_delta {
            let expected = ExpectedHeader {
                platform: Some(platform.manifest_platform().to_owned()),
                base_version: Some(self.config.current_version.clone()),
                target_version: Some(manifest.latest_version.clone()),
                source: Some(ExpectedFile::from(&delta.source)),
                target: Some(ExpectedFile::from(&delta.target)),
            };
            apply_delta_patch(
                &transfer_path,
                source_path,
                &target_path,
                ApplyOptions {
                    expected: Some(&expected),
                    cancel: Some(cancel),
                    progress: None,
                },
            )?;
            let _ = std::fs::remove_file(&transfer_path);
        }
        make_executable(&target_path, platform);
        Ok(staged(target_path))
    }

    /// Download the update for `manifest` (from [`CheckOutcome::Available`]).
    ///
    /// A delta is tried first when the manifest offers one and the installed
    /// file is its exact base; any delta problem falls back to the signed full
    /// package (unless the caller cancelled). Everything is verified by size
    /// and SHA-256 before the result is returned and remembered as pending.
    pub fn download(
        &mut self,
        manifest: &VerifiedManifest,
        cancel: &AtomicBool,
        mut progress: Option<&mut dyn FnMut(u64, u64)>,
    ) -> Result<StagedUpdate> {
        if !manifest.update_available {
            return err(
                ErrorKind::Manifest,
                "Es ist noch kein vollständig geprüftes Update bereit.",
            );
        }
        let directory = self.release_directory(manifest);
        make_private_dir(&directory)?;
        let mut fallback_reason = None;
        let mut delta = manifest.delta.clone();
        let mut delta_source = None;
        if let Some(offered) = &delta {
            match self.resolve_delta_source(offered) {
                Ok(path) => delta_source = Some(path),
                Err(error) => {
                    fallback_reason = Some(error.message);
                    delta = None;
                }
            }
        }
        let staged = match (&delta, &delta_source) {
            (Some(offered), Some(source)) => {
                match self.stage_selected(manifest, Some((offered, source)), cancel, &mut progress)
                {
                    Ok(staged) => staged,
                    Err(error) => {
                        if cancel.load(Ordering::SeqCst) || error.is_abort() {
                            return Err(error);
                        }
                        fallback_reason = Some(error.message);
                        self.stage_selected(manifest, None, cancel, &mut progress)?
                    }
                }
            }
            _ => self.stage_selected(manifest, None, cancel, &mut progress)?,
        };
        let staged = StagedUpdate {
            fallback_reason,
            ..staged
        };
        self.remember_pending_install(manifest, &staged)?;
        Ok(staged)
    }

    /// The final integrity check before an install helper may be started.
    pub fn verify_staged(&self, manifest: &VerifiedManifest, staged: &StagedUpdate) -> Result<()> {
        if !manifest.update_available {
            return err(
                ErrorKind::Manifest,
                "Es ist noch kein vollständig geprüftes Update bereit.",
            );
        }
        let (size, sha) = match (&manifest.delta, staged.used_delta) {
            (Some(delta), true) => (delta.target.size_bytes, delta.target.sha256.as_str()),
            _ => {
                let package = manifest.primary_package(self.config.platform);
                (package.size_bytes, package.sha256.as_str())
            }
        };
        let intact = std::fs::symlink_metadata(&staged.target_path)
            .is_ok_and(|m| is_plain_file(&m) && m.len() == size)
            && sha256_file(&staged.target_path).is_ok_and(|hash| hash == sha);
        if !intact {
            return Err(UpdateError::new(
                ErrorKind::Hash,
                "Das vorbereitete Update hat die abschließende Integritätsprüfung nicht bestanden.",
            ));
        }
        Ok(())
    }
}

#[cfg(unix)]
fn make_executable(path: &Path, platform: Platform) {
    use std::os::unix::fs::PermissionsExt;
    if platform == Platform::Linux {
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }
}

#[cfg(not(unix))]
fn make_executable(_path: &Path, _platform: Platform) {}
