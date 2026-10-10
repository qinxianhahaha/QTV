/** Network, codec and missing-stream failures do not establish an offline status. */
export function isConfirmedOfflineError(message: string): boolean {
  return /^(?:主播|直播间|当前直播间|房间|当前)?未开播[。.!！]?$/.test(message.trim());
}
