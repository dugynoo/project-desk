//! Poistka proti sirotám: na Windows zaradíme aplikáciu do Job Objectu s
//! `KILL_ON_JOB_CLOSE`. Shelly aj všetko, čo z nich vznikne (claude, codex, node…),
//! zdedia job, a keď aplikácia skončí akokoľvek, aj pádom alebo cez Správcu úloh,
//! systém ich ukončí spolu s ňou.

#[cfg(windows)]
pub fn kill_children_on_exit() -> Result<(), String> {
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    // SAFETY: volania WinAPI s platnými argumentmi; handle jobu zámerne nikdy nezatvárame,
    // systém ho zatvorí až pri skončení procesu a vtedy ukončí aj deti.
    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if job.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
        // BREAKAWAY_OK: proces, ktorý si o to výslovne požiada, môže z jobu odísť.
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        let ok = SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 || AssignProcessToJobObject(job, GetCurrentProcess()) == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

#[cfg(all(test, windows))]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn alive(pid: u32) -> bool {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    /// Pomocný proces pre test nižšie: zapne poistku, spustí vnuka a čaká.
    #[test]
    #[ignore]
    fn helper() {
        if std::env::var_os("PD_JOB_HELPER").is_none() {
            return;
        }
        super::kill_children_on_exit().unwrap();
        let child = Command::new("powershell.exe").args(["-NoProfile", "-Command", "Start-Sleep 60"]).spawn().unwrap();
        println!("PID={}", child.id());
        std::thread::sleep(Duration::from_secs(60));
    }

    #[test]
    fn grandchild_dies_when_app_is_killed() {
        let mut app = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "job::tests::helper", "--nocapture"])
            .env("PD_JOB_HELPER", "1")
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let pid: u32 = BufReader::new(app.stdout.take().unwrap())
            .lines()
            .map_while(Result::ok)
            .find_map(|l| l.strip_prefix("PID=").map(|p| p.trim().parse().unwrap()))
            .unwrap();
        assert!(alive(pid));
        app.kill().unwrap(); // ako pád alebo Správca úloh
        app.wait().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        assert!(!alive(pid), "vnuk {pid} prežil ukončenie aplikácie");
    }
}

/// Na macOS a Linuxe zatiaľ stačí `kill_all` pri ukončení.
#[cfg(not(windows))]
pub fn kill_children_on_exit() -> Result<(), String> {
    Ok(())
}
