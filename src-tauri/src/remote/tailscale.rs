//! Read-only zistenie adresy v tailnete. Project Desk Tailscale nikdy nekonfiguruje.

use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tailnet {
    /// Napr. `pc.tail1.ts.net` (bez koncovej bodky a schémy).
    pub host: String,
    pub serving: bool,
}

/// `Self.DNSName` z `tailscale status --json`, bez koncovej bodky.
pub fn parse_status(json: &str) -> Option<String> {
    let value: Value = serde_json::from_str(json).ok()?;
    let name = value.get("Self")?.get("DNSName")?.as_str()?;
    let name = name.trim().trim_end_matches('.');
    (!name.is_empty()).then(|| name.to_string())
}

/// Či niektorý handler v `tailscale serve status --json` proxuje na `127.0.0.1:{port}` / `localhost:{port}`.
pub fn parse_serving(json: &str, port: u16) -> bool {
    let Ok(value) = serde_json::from_str::<Value>(json) else { return false };
    let targets = [
        format!("http://127.0.0.1:{port}"),
        format!("http://localhost:{port}"),
    ];
    let forwards = [format!("127.0.0.1:{port}"), format!("localhost:{port}")];
    let matches = |text: &str, wanted: &[String]| {
        wanted.iter().any(|t| {
            text == t || text.strip_prefix(t.as_str()).is_some_and(|rest| rest.starts_with('/'))
        })
    };
    let web = value.get("Web").and_then(Value::as_object).is_some_and(|hosts| {
        hosts.values().any(|host| {
            host.get("Handlers").and_then(Value::as_object).is_some_and(|handlers| {
                handlers.values().any(|h| {
                    h.get("Proxy").and_then(Value::as_str).is_some_and(|p| matches(p, &targets))
                })
            })
        })
    });
    web || value.get("TCP").and_then(Value::as_object).is_some_and(|ports| {
        ports.values().any(|h| {
            h.get("TCPForward").and_then(Value::as_str).is_some_and(|f| forwards.iter().any(|t| t == f))
        })
    })
}

/// `tailscale` z PATH, na Windows aj `C:\Program Files\Tailscale\tailscale.exe`. Timeout 3 s.
pub fn detect(port: u16) -> Option<Tailnet> {
    if let Some(tailnet) = detect_with(Path::new("tailscale"), port) {
        return Some(tailnet);
    }
    #[cfg(windows)]
    {
        let installed = Path::new(r"C:\Program Files\Tailscale\tailscale.exe");
        if installed.is_file() {
            return detect_with(installed, port);
        }
    }
    None
}

pub fn detect_with(program: &Path, port: u16) -> Option<Tailnet> {
    let host = parse_status(&run(program, &["status", "--json"])?)?;
    // Chyba `serve status` znamená len, že nič nezdieľame.
    let serving = run(program, &["serve", "status", "--json"]).is_some_and(|out| parse_serving(&out, port));
    Some(Tailnet { host, serving })
}

/// Spustí CLI bez shellu s limitom 3 s; pri chybe alebo timeoute vráti `None`.
fn run(program: &Path, args: &[&str]) -> Option<String> {
    let mut command = Command::new(program);
    command.args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
    let mut child = command.spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // Čítanie vo vlákne, aby plná rúra nezablokovala proces.
    let reader = std::thread::spawn(move || {
        let mut out = String::new();
        stdout.read_to_string(&mut out).ok().map(|_| out)
    });
    let deadline = Instant::now() + Duration::from_secs(3);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };
    let out = reader.join().ok()??;
    status.success().then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_status_strips_trailing_dot() {
        let json = r#"{"Self":{"DNSName":"pc.tail1.ts.net."}}"#;
        assert_eq!(parse_status(json).as_deref(), Some("pc.tail1.ts.net"));
    }

    #[test]
    fn parse_status_missing_self_is_none() {
        assert_eq!(parse_status(r#"{"BackendState":"Stopped"}"#), None);
        assert_eq!(parse_status("nie json"), None);
        assert_eq!(parse_status(r#"{"Self":{"DNSName":"."}}"#), None);
    }

    #[test]
    fn parse_serving_matches_our_port() {
        let json = r#"{"Web":{"pc.tail1.ts.net:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:47615"}}}}}"#;
        assert!(parse_serving(json, 47615));
        assert!(!parse_serving(json, 1234));
        let localhost = r#"{"Web":{"h:443":{"Handlers":{"/":{"Proxy":"http://localhost:47615/"}}}}}"#;
        assert!(parse_serving(localhost, 47615));
        assert!(!parse_serving(r#"{"Web":{"h:443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:476150"}}}}}"#, 47615));
        assert!(!parse_serving("{}", 47615));
    }

    #[test]
    fn parse_serving_accepts_tcp_forward() {
        let json = r#"{"TCP":{"443":{"TCPForward":"127.0.0.1:47615"}}}"#;
        assert!(parse_serving(json, 47615));
        assert!(!parse_serving(json, 1));
    }

    #[test]
    fn detect_without_cli_is_none() {
        assert_eq!(detect_with(Path::new("/definitely/missing/tailscale-xyz"), 47615), None);
    }
}
