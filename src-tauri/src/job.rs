//! Poistka proti sirotám: na Windows zaradíme aplikáciu do Job Objectu s
//! `KILL_ON_JOB_CLOSE`. Shelly aj všetko, čo z nich vznikne (claude, codex, node…),
//! zdedia job, a keď aplikácia skončí akokoľvek, aj pádom alebo cez Správcu úloh,
//! systém ich ukončí spolu s ňou.
//!
//! Výnimka je inštalátor aktualizácie: updater ho spustí a hneď ukončí aplikáciu, takže
//! pred aktualizáciou nové procesy z jobu púšťame (`let_new_processes_out`).

#[cfg(windows)]
mod imp {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK,
    };
    use windows_sys::Win32::System::Threading::GetCurrentProcess;

    /// Handle jobu ako číslo (raw pointer nie je `Sync`). Zámerne ho nikdy nezatvárame,
    /// systém ho zatvorí až pri skončení procesu a vtedy ukončí aj deti.
    static JOB: OnceLock<usize> = OnceLock::new();

    fn set_flags(job: usize, silent_breakaway: bool) -> Result<(), String> {
        let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
        // BREAKAWAY_OK: proces, ktorý si o to výslovne požiada, môže z jobu odísť (editory).
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_BREAKAWAY_OK;
        // SILENT_BREAKAWAY_OK: nové procesy do jobu vôbec nevstúpia.
        if silent_breakaway {
            info.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
        }
        // SAFETY: platný handle jobu a štruktúra so správnou veľkosťou.
        let ok = unsafe {
            SetInformationJobObject(
                job as _,
                JobObjectExtendedLimitInformation,
                (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if ok == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(())
    }

    pub fn kill_children_on_exit() -> Result<(), String> {
        // SAFETY: volania WinAPI s platnými argumentmi.
        let job = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        set_flags(job as usize, false)?;
        if unsafe { AssignProcessToJobObject(job, GetCurrentProcess()) } == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let _ = JOB.set(job as usize);
        Ok(())
    }

    /// Zapne alebo vypne púšťanie nových procesov mimo job. Už bežiace terminály v jobe ostávajú.
    pub fn let_new_processes_out(on: bool) -> Result<(), String> {
        match JOB.get() {
            Some(&job) => set_flags(job, on),
            None => Ok(()),
        }
    }
}

#[cfg(windows)]
pub use imp::{kill_children_on_exit, let_new_processes_out};

#[cfg(all(test, windows))]
mod tests {
    use std::io::{BufRead, BufReader};
    use std::process::{Command, Stdio};
    use std::time::Duration;

    fn alive(pid: u32) -> bool {
        let out = Command::new("tasklist").args(["/FI", &format!("PID eq {pid}"), "/NH"]).output().unwrap();
        String::from_utf8_lossy(&out.stdout).contains(&pid.to_string())
    }

    /// Pomocný proces pre testy nižšie: zapne poistku, spustí vnuka a čaká.
    /// S `PD_JOB_HELPER=out` pred spustením vnuka púšťa nové procesy z jobu (ako pred aktualizáciou).
    #[test]
    #[ignore]
    #[allow(clippy::zombie_processes)] // vnuka má zabiť Job Object, nie wait()
    fn helper() {
        let Some(mode) = std::env::var_os("PD_JOB_HELPER") else { return };
        super::kill_children_on_exit().unwrap();
        if mode == "out" {
            super::let_new_processes_out(true).unwrap();
        }
        let child = Command::new("powershell.exe").args(["-NoProfile", "-Command", "Start-Sleep 60"]).spawn().unwrap();
        println!("PID={}", child.id());
        std::thread::sleep(Duration::from_secs(60));
    }

    /// Spustí pomocníka, zabije ho (ako pád alebo Správca úloh) a povie, či vnuk prežil.
    fn grandchild_survives(mode: &str) -> bool {
        let mut app = Command::new(std::env::current_exe().unwrap())
            .args(["--ignored", "--exact", "job::tests::helper", "--nocapture"])
            .env("PD_JOB_HELPER", mode)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let pid: u32 = BufReader::new(app.stdout.take().unwrap())
            .lines()
            .map_while(Result::ok)
            .find_map(|l| l.strip_prefix("PID=").map(|p| p.trim().parse().unwrap()))
            .unwrap();
        assert!(alive(pid));
        app.kill().unwrap();
        app.wait().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let survived = alive(pid);
        if survived {
            let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output();
        }
        survived
    }

    #[test]
    fn grandchild_dies_when_app_is_killed() {
        assert!(!grandchild_survives("1"), "vnuk prežil ukončenie aplikácie");
    }

    #[test]
    fn update_installer_survives_app_exit() {
        assert!(grandchild_survives("out"), "proces spustený pred aktualizáciou zomrel s aplikáciou");
    }
}

/// Na macOS a Linuxe zatiaľ stačí `kill_all` pri ukončení.
#[cfg(not(windows))]
pub fn kill_children_on_exit() -> Result<(), String> {
    Ok(())
}

#[cfg(not(windows))]
pub fn let_new_processes_out(_on: bool) -> Result<(), String> {
    Ok(())
}
