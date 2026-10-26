//! WebKitGTK's DMA-BUF renderer asks NVIDIA's GBM for buffers it cannot
//! allocate ("Failed to create GBM buffer"), leaving a blank window. Fall back
//! to shared-memory transport only where WebKit actually renders on NVIDIA:
//! hybrid laptops rendering on the iGPU would otherwise lose acceleration.
use std::{ffi::OsStr, fs, path::Path};

const VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";

/// Call before any thread starts; WebKit reads the variable when it initializes.
/// A value set by the user, including "0", always wins.
pub fn configure() {
    if std::env::var_os(VAR).is_some() { return; }
    let offload = std::env::var_os("__NV_PRIME_RENDER_OFFLOAD").is_some_and(|v| v == "1");
    if nvidia_renders(Path::new("/sys"), offload) {
        std::env::set_var(VAR, "1");
    }
}

/// NVIDIA renders when the app is offloaded to it, when it is the only GPU
/// driver (also without nvidia-drm), or when it is the boot display GPU.
fn nvidia_renders(sys: &Path, offload: bool) -> bool {
    if !sys.join("module/nvidia").is_dir() { return false; }
    if offload { return true; }
    let mut other = false;
    let mut primary = false;
    for entry in fs::read_dir(sys.join("class/drm")).into_iter().flatten().flatten() {
        let name = entry.file_name();
        let Some(index) = name.to_str().and_then(|n| n.strip_prefix("card")) else { continue; };
        if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) { continue; }
        let device = entry.path().join("device");
        let Ok(driver) = fs::read_link(device.join("driver")) else { continue; };
        if driver.file_name() != Some(OsStr::new("nvidia")) { other = true; continue; }
        primary |= fs::read_to_string(device.join("boot_vga")).is_ok_and(|v| v.trim() == "1");
    }
    !other || primary
}

#[cfg(test)]
mod tests {
    use super::nvidia_renders;
    use std::{fs, os::unix::fs::symlink, path::Path};

    fn card(sys: &Path, name: &str, driver: &str, boot_vga: bool) {
        let device = sys.join("class/drm").join(name).join("device");
        fs::create_dir_all(&device).unwrap();
        symlink(format!("../../bus/pci/drivers/{driver}"), device.join("driver")).unwrap();
        fs::write(device.join("boot_vga"), if boot_vga { "1\n" } else { "0\n" }).unwrap();
    }

    fn sys(nvidia: bool) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir_all(dir.path().join("class/drm")).unwrap();
        if nvidia { fs::create_dir_all(dir.path().join("module/nvidia")).unwrap(); }
        dir
    }

    #[test]
    fn nvidia_only_systems_need_the_fallback_even_without_drm_cards() {
        let dir = sys(true);
        assert!(nvidia_renders(dir.path(), false));
        card(dir.path(), "card1", "nvidia", false);
        fs::create_dir_all(dir.path().join("class/drm/card1-DP-1")).unwrap();
        assert!(nvidia_renders(dir.path(), false));
    }

    #[test]
    fn hybrid_systems_follow_the_display_gpu_or_prime_offload() {
        let dir = sys(true);
        card(dir.path(), "card0", "i915", true);
        card(dir.path(), "card1", "nvidia", false);
        assert!(!nvidia_renders(dir.path(), false), "iGPU renders; keep DMA-BUF");
        assert!(nvidia_renders(dir.path(), true));
        let dir = sys(true);
        card(dir.path(), "card0", "amdgpu", false);
        card(dir.path(), "card1", "nvidia", true);
        assert!(nvidia_renders(dir.path(), false));
    }

    #[test]
    fn other_drivers_are_untouched() {
        let dir = sys(false);
        card(dir.path(), "card0", "nouveau", true);
        assert!(!nvidia_renders(dir.path(), true));
    }
}
