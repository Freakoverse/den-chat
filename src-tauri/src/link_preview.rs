use serde::Serialize;
use std::net::IpAddr;
use std::time::Duration;

/// OG/meta tags live in <head>, so we never need the whole page — cap what we read
/// to keep a hostile/huge response from exhausting memory.
const MAX_BODY_BYTES: usize = 512 * 1024;
const MAX_REDIRECTS: usize = 5;

#[derive(Debug, Serialize)]
pub struct LinkPreviewData {
    pub title: Option<String>,
    pub description: Option<String>,
    pub image: Option<String>,
    #[serde(rename = "siteName")]
    pub site_name: Option<String>,
}

/// Fetch a URL and extract OpenGraph / meta tag data for link previews.
///
/// Called from the frontend via `invoke('fetch_link_preview', { url })`.
///
/// SSRF hardening: this fetches an attacker-influenced URL from the desktop's
/// network, so it is restricted to `https` and to public hosts. Redirects are
/// followed manually so every hop is re-validated (a public URL can't bounce to
/// `http://localhost` or a LAN address). We validate the *resolved* IPs, so a
/// hostname that resolves to a private/loopback address is rejected too. (A small
/// TOCTOU window remains between our resolve and reqwest's connect — acceptable for
/// a desktop link-preview; a stricter version would pin the connection to the
/// validated IP.)
#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreviewData, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .user_agent("DEN Chat/0.1.0 LinkPreview")
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?;

    // Follow up to MAX_REDIRECTS hops, validating each target before we send.
    let mut current = url;
    let mut response = None;
    for _ in 0..=MAX_REDIRECTS {
        validate_url(&current).await?;
        let resp = client
            .get(&current)
            .send()
            .await
            .map_err(|e| format!("Fetch failed: {e}"))?;
        if resp.status().is_redirection() {
            let loc = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .ok_or_else(|| "Redirect without a Location header".to_string())?;
            let base = url::Url::parse(&current).map_err(|_| "Invalid URL".to_string())?;
            current = base
                .join(loc)
                .map_err(|_| "Invalid redirect target".to_string())?
                .to_string();
            continue;
        }
        response = Some(resp);
        break;
    }
    let mut response = response.ok_or_else(|| "Too many redirects".to_string())?;

    // Only process HTML responses
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type.contains("text/html") {
        return Err("Not an HTML page".into());
    }

    // Read the body but cap it — don't download whole files when we only need <head>.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("Failed to read body: {e}"))?
    {
        buf.extend_from_slice(&chunk);
        if buf.len() >= MAX_BODY_BYTES {
            buf.truncate(MAX_BODY_BYTES);
            break;
        }
    }
    let body = String::from_utf8_lossy(&buf).into_owned();

    // Parse HTML and extract metadata
    let document = scraper::Html::parse_document(&body);

    let title = extract_meta(&document, "og:title")
        .or_else(|| extract_meta(&document, "twitter:title"))
        .or_else(|| extract_title(&document));

    let description = extract_meta(&document, "og:description")
        .or_else(|| extract_meta(&document, "twitter:description"))
        .or_else(|| extract_meta_name(&document, "description"));

    let image = extract_meta(&document, "og:image")
        .or_else(|| extract_meta(&document, "twitter:image"))
        .map(|img| resolve_url(&current, &img));

    let site_name = extract_meta(&document, "og:site_name");

    Ok(LinkPreviewData {
        title,
        description,
        image,
        site_name,
    })
}

/// Require https and reject hosts that resolve to a private/loopback/link-local
/// address (SSRF guard). Called before every request, including each redirect hop.
async fn validate_url(raw: &str) -> Result<(), String> {
    let parsed = url::Url::parse(raw).map_err(|_| "Invalid URL".to_string())?;
    if parsed.scheme() != "https" {
        return Err("Only https links can be previewed".into());
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL has no host".to_string())?;
    let port = parsed.port().unwrap_or(443);

    // Literal IP — check directly (no DNS).
    if let Ok(ip) = host.parse::<IpAddr>() {
        return check_ip(ip);
    }
    // Hostname — resolve and reject if ANY resolved address is non-public.
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|_| "Could not resolve host".to_string())?;
    let mut saw_any = false;
    for addr in addrs {
        saw_any = true;
        check_ip(addr.ip())?;
    }
    if !saw_any {
        return Err("Host did not resolve".into());
    }
    Ok(())
}

/// Block loopback, private, link-local, CGNAT, multicast, and unspecified ranges.
fn check_ip(ip: IpAddr) -> Result<(), String> {
    // Unwrap IPv4-mapped IPv6 (::ffff:127.0.0.1) so it can't dodge the v4 checks.
    let ip = match ip {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    };
    let blocked = match ip {
        IpAddr::V4(a) => {
            a.is_loopback()
                || a.is_private()
                || a.is_link_local()
                || a.is_unspecified()
                || a.is_broadcast()
                || a.is_documentation()
                || a.is_multicast()
                || a.octets()[0] == 0
                || (a.octets()[0] == 100 && (a.octets()[1] & 0xc0) == 64) // 100.64.0.0/10 CGNAT
        }
        IpAddr::V6(a) => {
            a.is_loopback()
                || a.is_unspecified()
                || a.is_multicast()
                || (a.segments()[0] & 0xfe00) == 0xfc00 // fc00::/7 unique-local
                || (a.segments()[0] & 0xffc0) == 0xfe80 // fe80::/10 link-local
        }
    };
    if blocked {
        Err("Refusing to fetch a private, loopback, or link-local address".into())
    } else {
        Ok(())
    }
}

/// Extract content from a `<meta property="..." content="...">` tag.
fn extract_meta(document: &scraper::Html, property: &str) -> Option<String> {
    let selector =
        scraper::Selector::parse(&format!("meta[property=\"{property}\"]")).ok()?;
    document
        .select(&selector)
        .next()
        .and_then(|el| el.value().attr("content"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Extract content from a `<meta name="..." content="...">` tag.
fn extract_meta_name(document: &scraper::Html, name: &str) -> Option<String> {
    let selector =
        scraper::Selector::parse(&format!("meta[name=\"{name}\"]")).ok()?;
    document
        .select(&selector)
        .next()
        .and_then(|el| el.value().attr("content"))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Extract the page `<title>` text.
fn extract_title(document: &scraper::Html) -> Option<String> {
    let selector = scraper::Selector::parse("title").ok()?;
    document
        .select(&selector)
        .next()
        .map(|el| el.text().collect::<String>())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Resolve a potentially relative image URL against the base URL.
fn resolve_url(base: &str, href: &str) -> String {
    if href.starts_with("http://") || href.starts_with("https://") || href.starts_with("//") {
        if href.starts_with("//") {
            return format!("https:{href}");
        }
        return href.to_string();
    }
    // Try to resolve relative URL
    if let Ok(base_url) = url::Url::parse(base) {
        if let Ok(resolved) = base_url.join(href) {
            return resolved.to_string();
        }
    }
    href.to_string()
}
