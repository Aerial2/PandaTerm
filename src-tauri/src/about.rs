use std::time::Duration;

use reqwest::{header, Client, StatusCode};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

const GITHUB_API_ROOT: &str = "https://api.github.com";
const GITHUB_WEB_ROOT: &str = "https://github.com";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LatestGithubVersion {
    ok: bool,
    version: String,
    tag: String,
    html_url: String,
    source: &'static str,
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    html_url: Option<String>,
}

#[derive(Deserialize)]
struct GithubTag {
    name: String,
}

fn validate_repo(repo: &str) -> Result<&str, String> {
    let valid_segment = |segment: &str| {
        !segment.is_empty()
            && segment.chars().all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | '.')
            })
    };
    let mut segments = repo.split('/');
    let owner = segments.next().unwrap_or_default();
    let name = segments.next().unwrap_or_default();
    if !valid_segment(owner) || !valid_segment(name) || segments.next().is_some() {
        return Err("GitHub 仓库格式无效".to_string());
    }
    Ok(repo)
}

fn normalize_version(tag: &str) -> String {
    tag.trim()
        .strip_prefix('v')
        .or_else(|| tag.trim().strip_prefix('V'))
        .unwrap_or(tag.trim())
        .to_string()
}

fn version_result(
    repo: &str,
    tag: String,
    html_url: Option<String>,
    source: &'static str,
) -> LatestGithubVersion {
    LatestGithubVersion {
        ok: true,
        version: normalize_version(&tag),
        html_url: html_url.unwrap_or_else(|| format!("{GITHUB_WEB_ROOT}/{repo}/releases")),
        tag,
        source,
    }
}

fn parse_atom_release(repo: &str, xml: &str) -> Result<LatestGithubVersion, String> {
    let entry = xml
        .split_once("<entry>")
        .map(|(_, remainder)| remainder)
        .ok_or_else(|| "GitHub 仓库尚无公开 Release".to_string())?;
    let marker = "/releases/tag/";
    let marker_index = entry
        .find(marker)
        .ok_or_else(|| "GitHub Release Feed 缺少版本链接".to_string())?;
    let href_start = entry[..marker_index]
        .rfind("href=\"")
        .map(|index| index + "href=\"".len())
        .ok_or_else(|| "GitHub Release Feed 链接格式无效".to_string())?;
    let href_tail = &entry[href_start..];
    let href_end = href_tail
        .find('"')
        .ok_or_else(|| "GitHub Release Feed 链接格式无效".to_string())?;
    let html_url = &href_tail[..href_end];
    let tag = html_url
        .split_once(marker)
        .map(|(_, tag)| tag.trim())
        .filter(|tag| !tag.is_empty())
        .ok_or_else(|| "GitHub Release Feed 缺少版本标签".to_string())?;

    Ok(version_result(
        repo,
        tag.to_string(),
        Some(html_url.to_string()),
        "release",
    ))
}

async fn fetch_from_atom(client: &Client, repo: &str) -> Result<LatestGithubVersion, String> {
    let response = client
        .get(format!("{GITHUB_WEB_ROOT}/{repo}/releases.atom"))
        .send()
        .await
        .map_err(|error| format!("GitHub Release Feed 请求失败：{error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("GitHub Release Feed HTTP {}", status.as_u16()));
    }
    let xml = response
        .text()
        .await
        .map_err(|error| format!("GitHub Release Feed 读取失败：{error}"))?;
    parse_atom_release(repo, &xml)
}

async fn fetch_from_tags(client: &Client, repo: &str) -> Result<LatestGithubVersion, String> {
    let response = client
        .get(format!("{GITHUB_API_ROOT}/repos/{repo}/tags?per_page=1"))
        .send()
        .await
        .map_err(|error| format!("GitHub Tags 请求失败：{error}"))?;
    if !response.status().is_success() {
        return fetch_from_atom(client, repo).await;
    }
    let tags = response
        .json::<Vec<GithubTag>>()
        .await
        .map_err(|error| format!("GitHub Tags 响应无效：{error}"))?;
    let tag = tags
        .into_iter()
        .next()
        .map(|tag| tag.name)
        .filter(|tag| !tag.trim().is_empty())
        .ok_or_else(|| "GitHub 仓库尚无 Release 或 Tag".to_string())?;
    Ok(version_result(repo, tag, None, "tag"))
}

#[tauri::command]
pub fn open_external_url(app: AppHandle, url: String) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url.trim()).map_err(|_| "外链地址无效".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err("只允许打开 GitHub HTTPS 链接".to_string());
    }
    app.opener()
        .open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("系统浏览器打开失败：{error}"))
}

#[tauri::command]
pub async fn fetch_latest_github_version(repo: String) -> Result<LatestGithubVersion, String> {
    let repo = validate_repo(repo.trim())?;
    let client = Client::builder()
        .user_agent(format!("PandaTerm/{}", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(12))
        .default_headers({
            let mut headers = header::HeaderMap::new();
            headers.insert(
                header::ACCEPT,
                header::HeaderValue::from_static("application/vnd.github+json"),
            );
            headers.insert(
                "x-github-api-version",
                header::HeaderValue::from_static("2022-11-28"),
            );
            headers
        })
        .build()
        .map_err(|error| format!("版本检查客户端初始化失败：{error}"))?;

    let response = client
        .get(format!("{GITHUB_API_ROOT}/repos/{repo}/releases/latest"))
        .send()
        .await
        .map_err(|_| "GitHub API 不可用，正在尝试 Release Feed".to_string());

    let response = match response {
        Ok(response) => response,
        Err(_) => return fetch_from_atom(&client, repo).await,
    };

    match response.status() {
        status if status.is_success() => {
            let release = response
                .json::<GithubRelease>()
                .await
                .map_err(|error| format!("GitHub Release 响应无效：{error}"))?;
            if release.tag_name.trim().is_empty() {
                return Err("GitHub Release 缺少版本标签".to_string());
            }
            Ok(version_result(
                repo,
                release.tag_name,
                release.html_url,
                "release",
            ))
        }
        StatusCode::NOT_FOUND => fetch_from_tags(&client, repo).await,
        _ => fetch_from_atom(&client, repo).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_first_release_from_atom_feed() {
        let xml = r#"<feed><entry><link rel="alternate" type="text/html" href="https://github.com/Aerial2/PandaTerm/releases/tag/v0.1.0"/></entry></feed>"#;
        let release = parse_atom_release("Aerial2/PandaTerm", xml).expect("parse release");
        assert_eq!(release.version, "0.1.0");
        assert_eq!(release.tag, "v0.1.0");
        assert_eq!(
            release.html_url,
            "https://github.com/Aerial2/PandaTerm/releases/tag/v0.1.0"
        );
        let json = serde_json::to_value(&release).expect("serialize release");
        assert_eq!(json["ok"], true);
        assert_eq!(json["htmlUrl"], release.html_url);
    }

    #[test]
    fn rejects_invalid_repository_paths() {
        assert!(validate_repo("Aerial2/PandaTerm").is_ok());
        assert!(validate_repo("https://github.com/Aerial2/PandaTerm").is_err());
        assert!(validate_repo("Aerial2/../secret").is_err());
    }
}
