//! Web Push na mobil: desktop (`src/web-push.ts`) správu zašifruje a podpíše, tu sa len odošle.

use std::time::Duration;

use base64::Engine;

/// Push služby prehliadačov; na inú adresu desktop nič neposiela.
const HOSTS: [&str; 4] = ["push.apple.com", "fcm.googleapis.com", "push.services.mozilla.com", "notify.windows.com"];
/// Jedna notifikácia je pár stoviek bajtov; push služby berú najviac 4 KiB.
const MAX_BODY: usize = 4096;

pub fn endpoint_allowed(endpoint: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else { return false };
    url.scheme() == "https"
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.host_str().is_some_and(|h| HOSTS.iter().any(|d| h == *d || h.strip_suffix(d).is_some_and(|sub| sub.ends_with('.'))))
}

/// Odošle zašifrovanú správu (`body` v base64) a vráti HTTP stav; 404 a 410 = odber už neplatí.
pub async fn send(endpoint: &str, authorization: &str, body: &str, urgent: bool) -> Result<u16, String> {
    if !endpoint_allowed(endpoint) {
        return Err("remote.pushFailed: endpoint".into());
    }
    let body = base64::engine::general_purpose::STANDARD.decode(body).map_err(|_| "remote.pushFailed: body".to_string())?;
    if body.len() > MAX_BODY {
        return Err("remote.pushFailed: body".into());
    }
    let _ = rustls::crypto::ring::default_provider().install_default();
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| format!("remote.pushFailed: {e}"))?;
    let response = client
        .post(endpoint)
        .header("TTL", "86400")
        .header("Urgency", if urgent { "high" } else { "normal" })
        .header("Content-Encoding", "aes128gcm")
        .header("Content-Type", "application/octet-stream")
        .header("Authorization", authorization)
        .body(body)
        .send()
        .await
        .map_err(|e| format!("remote.pushFailed: {e}"))?;
    Ok(response.status().as_u16())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_browser_push_services_over_https() {
        for ok in [
            "https://web.push.apple.com/QGuQyavXutnMH",
            "https://fcm.googleapis.com/fcm/send/abc:def",
            "https://updates.push.services.mozilla.com/wpush/v2/gAAA",
            "https://wns2-par02p.notify.windows.com/w/?token=x",
        ] {
            assert!(endpoint_allowed(ok), "{ok}");
        }
        for bad in [
            "http://web.push.apple.com/x",
            "https://web.push.apple.com:8443/x",
            "https://evilpush.apple.com.example.com/x",
            "https://xpush.apple.com/x",
            "https://user@fcm.googleapis.com/x",
            "https://127.0.0.1/x",
            "https://localhost/x",
            "not a url",
        ] {
            assert!(!endpoint_allowed(bad), "{bad}");
        }
    }

    #[tokio::test]
    async fn send_refuses_other_hosts_before_connecting() {
        assert_eq!(send("https://127.0.0.1/x", "vapid t=a, k=b", "AA==", false).await, Err("remote.pushFailed: endpoint".into()));
    }
}
