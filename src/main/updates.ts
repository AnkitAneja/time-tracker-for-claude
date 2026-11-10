// Checks GitHub for a newer release. The app isn't code-signed, so macOS won't let it
// update itself; instead the tray shows a link to download the new version.

export const RELEASES_API = 'https://api.github.com/repos/AnkitAneja/time-tracker-for-claude/releases/latest'

export interface UpdateInfo {
  version: string
  url: string
}

/** Compares dotted versions like "0.10.2" > "0.9.9". A leading "v" is ignored. */
export function isNewer(latest: string, current: string): boolean {
  const parse = (v: string): number[] => v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map((n) => parseInt(n, 10) || 0)
  const a = parse(latest)
  const b = parse(current)
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i]
  return false
}

/** Returns the latest published release if it's newer than `current`, else null. Never throws. */
export async function checkForUpdate(current: string, fetchFn: typeof fetch = fetch): Promise<UpdateInfo | null> {
  try {
    const res = await fetchFn(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'time-tracker-for-claude' }
    })
    if (!res.ok) return null
    const body = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean }
    if (!body.tag_name || !body.html_url || body.draft || body.prerelease) return null
    return isNewer(body.tag_name, current) ? { version: body.tag_name.replace(/^v/, ''), url: body.html_url } : null
  } catch {
    return null
  }
}
