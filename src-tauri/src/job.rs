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

/// One terminal session's process tree. Nested inside the app job (Windows 8+), so the app-exit
/// guarantee above still holds. No `KILL_ON_JOB_CLOSE`: a shell that exits on its own leaves its
/// background processes running as before; only an explicit close, pause or restart ends the tree.
/// `BREAKAWAY_OK` like the app job, so processes that ask to leave (editors) are not killed.
#[cfg(windows)]
pub struct SessionJob(usize);

#[cfg(windows)]
impl SessionJob {
    /// `None` when the process cannot be assigned (already exited, or jobs are restricted);
    /// the caller then terminates just the process, as before.
    pub fn assign(pid: u32) -> Option<Self> {
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_BREAKAWAY_OK,
        };
        use windows_sys::Win32::System::Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE};
        // SAFETY: every handle is checked and closed on every path (the job by `Drop`).
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job.is_null() { return None; }
            let job = SessionJob(job as usize);
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_BREAKAWAY_OK;
            let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
            if SetInformationJobObject(job.0 as _, JobObjectExtendedLimitInformation, (&info as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(), size) == 0 {
                return None;
            }
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() { return None; }
            let assigned = AssignProcessToJobObject(job.0 as _, process) != 0;
            CloseHandle(process);
            assigned.then_some(job)
        }
    }

    /// Ends every process in the session's tree that has not broken away.
    pub fn terminate(&self) -> std::io::Result<()> {
        use windows_sys::Win32::System::JobObjects::TerminateJobObject;
        // SAFETY: the handle is owned by `self` and still open.
        if unsafe { TerminateJobObject(self.0 as _, 1) } != 0 { Ok(()) } else { Err(std::io::Error::last_os_error()) }
    }
}

#[cfg(windows)]
impl Drop for SessionJob {
    fn drop(&mut self) {
        // SAFETY: closes the handle this value owns; processes keep running (no kill-on-close).
        unsafe { windows_sys::Win32::Foundation::CloseHandle(self.0 as _); }
    }
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
    fn session_job_ends_the_whole_tree_and_only_on_terminate() {
        // A shell with a grandchild, like an agent that started an MCP server.
        let mut shell = Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", "$p = Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep 60' -PassThru -NoNewWindow; Write-Output \"PID=$($p.Id)\"; Start-Sleep 60"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let job = super::SessionJob::assign(shell.id()).expect("nested job");
        let pid: u32 = BufReader::new(shell.stdout.take().unwrap())
            .lines()
            .map_while(Result::ok)
            .find_map(|l| l.strip_prefix("PID=").map(|p| p.trim().parse().unwrap()))
            .unwrap();
        assert!(alive(pid));
        job.terminate().unwrap();
        shell.wait().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        let survived = alive(pid);
        if survived { let _ = Command::new("taskkill").args(["/F", "/PID", &pid.to_string()]).output(); }
        assert!(!survived, "grandchild outlived the session job");
    }

    #[test]
    fn closing_a_session_job_handle_keeps_its_processes() {
        let mut child = Command::new("powershell.exe").args(["-NoProfile", "-Command", "Start-Sleep 60"]).spawn().unwrap();
        drop(super::SessionJob::assign(child.id()).expect("nested job"));
        std::thread::sleep(Duration::from_millis(300));
        assert!(alive(child.id()), "a shell that exits on its own must not take its background processes");
        child.kill().unwrap();
        child.wait().unwrap();
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
