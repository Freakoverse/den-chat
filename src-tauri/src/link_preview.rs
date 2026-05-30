use serde::Serialize;

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
/// Returns structured preview data or an error string.
#[tauri::command]
pub async fn fetch_link_preview(url: String) -> Result<LinkPreviewData, String> {
    // Fetch the page HTML
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .user_agent("DEN Chat/0.1.0 LinkPreview")
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|e| format!("HTTP client error: {e}"))?
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("Fetch failed: {e}"))?;

    // Only process HTML responses
    let content_type = response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !content_type.contains("text/html") {
        return Err("Not an HTML page".into());
    }

    let body = response
        .text()
        .await
        .map_err(|e| format!("Failed to read body: {e}"))?;

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
        .map(|img| resolve_url(&url, &img));

    let site_name = extract_meta(&document, "og:site_name");

    Ok(LinkPreviewData {
        title,
        description,
        image,
        site_name,
    })
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
