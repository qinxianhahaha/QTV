/** Extract the public web room ID, never anchor_id (an unrelated user ID). */
export function parseDouyinRoomInput(input: string, allowBareId = true): string | null {
  const text = input.trim();
  if (allowBareId && /^\d{1,30}$/.test(text)) return text;
  const candidate = text.match(/https?:\/\/[^\s<>"\[\]）)]+/i)?.[0] ?? text;
  try {
    const url = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
    if (url.username || url.password || url.port) return null;
    if (url.hostname === "live.douyin.com") return url.pathname.match(/^\/(\d{1,30})\/?$/)?.[1] ?? null;
    if (url.hostname === "www.douyin.com" || url.hostname === "douyin.com") {
      return url.pathname.match(/^\/(?:follow\/)?live\/(\d{1,30})\/?$/)?.[1] ?? null;
    }
  } catch { /* Ordinary search text is not a URL. */ }
  return null;
}
