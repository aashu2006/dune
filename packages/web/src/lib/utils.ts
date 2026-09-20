export function formatNumber(num: number): string {
  return new Intl.NumberFormat('en-US').format(num);
}

/** 38204 -> "38K", 5100 -> "5.1K", 812 -> "812". */
export function formatCompact(num: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(num);
}

/** "just now", "5 minutes ago", "2 hours ago", "yesterday", "3 days ago", then a date. */
export function timeAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 14) return `${days} days ago`;
  return new Date(then).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "https://github.com/owner/repo" -> "owner/repo", for showing a repo before its meta exists. */
export function repoNameFromUrl(url: string): string {
  const match = /github\.com\/([^/\s]+\/[^/\s#?]+)/.exec(url);
  return match?.[1]?.replace(/\.git$/, '') ?? url;
}

/** "a, b ,, c" -> ["a", "b", "c"], for the comma-separated files field in forms. */
export function parseFileList(value: string): string[] {
  return [...new Set(value.split(',').map((f) => f.trim()).filter(Boolean))];
}
