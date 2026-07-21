/**
 * 关于 / 版本检查。
 *
 * 当前版本：Tauri app version（与 tauri.conf.json / workspace version 一致）
 * 最新版本：GitHub Releases API（releases/latest），无 release 时回退 tags
 *
 * 仓库：改 PANDATERM_GITHUB_REPO 即可（owner/repo）。
 * 当前 git remote 是 Codeup；若公开仓在 GitHub，填对应地址后即可自动检查。
 */

/** GitHub owner/repo，用于拉取最新 release / tag */
export const PANDATERM_GITHUB_REPO = 'Aerial2/PandaTerm';

export type LatestVersionOk = {
  ok: true;
  /** 去掉 v 前缀的版本号，如 0.2.0 */
  version: string;
  /** 原始 tag，如 v0.2.0 */
  tag: string;
  htmlUrl: string;
  source: 'release' | 'tag';
};

export type LatestVersionErr = {
  ok: false;
  error: string;
};

export type LatestVersionResult = LatestVersionOk | LatestVersionErr;

export function githubRepoUrl(repo = PANDATERM_GITHUB_REPO): string {
  return `https://github.com/${repo}`;
}

export function githubReleasesUrl(repo = PANDATERM_GITHUB_REPO): string {
  return `https://github.com/${repo}/releases`;
}

/** 去掉常见 tag 前缀，便于展示与比较 */
export function normalizeVersion(raw: string): string {
  return raw.trim().replace(/^v/i, '');
}

/** 简单 semver 比较：a>b → 1，a<b → -1，相等 → 0；无法解析时按字符串比 */
export function compareSemver(a: string, b: string): number {
  const pa = normalizeVersion(a).split(/[.+-]/).map((p) => Number.parseInt(p, 10));
  const pb = normalizeVersion(b).split(/[.+-]/).map((p) => Number.parseInt(p, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const na = Number.isFinite(pa[i]) ? pa[i]! : 0;
    const nb = Number.isFinite(pb[i]) ? pb[i]! : 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

/** 读取本机应用版本（打包后与 tauri.conf 一致） */
export async function getCurrentAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    return await getVersion();
  } catch {
    return '0.1.0';
  }
}

export async function fetchLatestGithubVersion(
  repo = PANDATERM_GITHUB_REPO,
): Promise<LatestVersionResult> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return await invoke<LatestVersionOk>('fetch_latest_github_version', { repo });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message || '版本检查失败' };
  }
}

/** 由 Rust 后端调用系统默认浏览器，失败时向界面返回具体原因。 */
export async function openExternalUrl(url: string): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  await invoke('open_external_url', { url });
}
