const ICON_HOSTS = [
  "steamcdn-a.akamaihd.net",
  "media.retroachievements.org",
  "images-eds-ssl.xboxlive.com",
  "store-images.s-microsoft.com",
];
const ICON_SUFFIXES = [".steamstatic.com"];

export function safeIcon(url: string | null | undefined): string | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  const host = parsed.hostname;
  return ICON_HOSTS.includes(host) || ICON_SUFFIXES.some((s) => host.endsWith(s)) ? url : null;
}
