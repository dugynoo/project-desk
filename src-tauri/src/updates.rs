//! Read-only release discovery for installations owned by a Linux package manager.
use serde::{Deserialize, Serialize};
use std::time::Duration;

pub fn automatic_updates() -> bool {
    !cfg!(target_os = "linux") || std::env::var_os("APPIMAGE").is_some()
}

#[derive(Deserialize)]
struct Release {
    tag_name: String,
    body: Option<String>,
    draft: bool,
    prerelease: bool,
}

#[derive(Serialize)]
pub struct AvailableRelease {
    version: String,
    body: String,
    url: String,
}

fn available(release: Release, current: &str) -> Result<Option<AvailableRelease>, String> {
    let version = semver::Version::parse(release.tag_name.trim_start_matches('v')).map_err(|e| e.to_string())?;
    let current = semver::Version::parse(current).map_err(|e| e.to_string())?;
    if release.draft || release.prerelease || !version.pre.is_empty() || version <= current {
        return Ok(None);
    }
    Ok(Some(AvailableRelease {
        url: format!("https://github.com/dugynoo/project-desk/releases/tag/v{version}"),
        version: version.to_string(),
        body: release.body.unwrap_or_default(),
    }))
}

#[tauri::command]
pub async fn check_release() -> Result<Option<AvailableRelease>, String> {
    async fn fetch() -> Result<Option<AvailableRelease>, String> {
        let _ = rustls::crypto::ring::default_provider().install_default();
        // Fixed origin, no tokens or arbitrary URLs supplied by the frontend.
        let client = reqwest::Client::builder().timeout(Duration::from_secs(15))
            .user_agent(concat!("Project-Desk/", env!("CARGO_PKG_VERSION")))
            .build().map_err(|e| e.to_string())?;
        let mut response = client.get("https://api.github.com/repos/dugynoo/project-desk/releases/latest")
            .header("Accept", "application/vnd.github+json")
            .send().await.map_err(|e| e.to_string())?;
        if response.status() == reqwest::StatusCode::NOT_FOUND { return Ok(None); }
        response.error_for_status_ref().map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
            if bytes.len() + chunk.len() > 1_048_576 { return Err("Release metadata exceeds size limit".into()); }
            bytes.extend_from_slice(&chunk);
        }
        let release = serde_json::from_slice(&bytes).map_err(|e| e.to_string())?;
        available(release, env!("CARGO_PKG_VERSION"))
    }
    fetch().await.map_err(|e| format!("update.checkFailed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn release(tag: &str) -> Release {
        Release { tag_name: tag.into(), body: Some("- Change".into()), draft: false, prerelease: false }
    }
    #[test]
    fn only_new_stable_releases_are_offered() {
        for tag in ["v0.5.0", "v0.4.9", "v0.6.0-beta.1"] {
            assert!(available(release(tag), "0.5.0").unwrap().is_none());
        }
        let mut r = release("v0.6.0"); r.draft = true;
        assert!(available(r, "0.5.0").unwrap().is_none());
        let mut r = release("v0.6.0"); r.prerelease = true;
        assert!(available(r, "0.5.0").unwrap().is_none());
        let r = available(release("v0.10.0"), "0.9.0").unwrap().unwrap();
        assert_eq!(r.version, "0.10.0");
        assert_eq!(r.url, "https://github.com/dugynoo/project-desk/releases/tag/v0.10.0");
        assert!(available(release("../../malicious"), "0.5.0").is_err());
    }
}
