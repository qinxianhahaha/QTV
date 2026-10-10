import { invoke } from '@tauri-apps/api/core';

let douyuProxyActive = false;

export async function getDouyuStreamConfig(roomId: string, quality = '原画', line?: string | null, route = 0, preferHevc = false) {
  const result = await invoke<{ url: string; actual_quality: string; quality_limited: boolean; line: string; requested_hevc: boolean }>('get_douyu_playback_cmd', {
    roomId, quality, line: line ?? null, route, preferHevc,
  });
  if (!result?.url) throw new Error('斗鱼直播流地址获取为空');
  await invoke('set_stream_url_cmd', { url: enforceHttps(result.url) });
  const proxyUrl = await invoke<string>('start_proxy');
  if (!proxyUrl) throw new Error('斗鱼播放代理启动失败');
  douyuProxyActive = true;
  return { streamUrl: proxyUrl, streamType: 'flv', actualQuality: result.actual_quality, qualityLimited: result.quality_limited, actualLine: result.line, requestedHevc: result.requested_hevc };
}

export async function stopDouyuProxy(): Promise<void> {
  if (!douyuProxyActive) {
    return;
  }
  try {
    await invoke('stop_proxy');
    douyuProxyActive = false;
  } catch (e) {
    console.error('[DouyuPlayerHelper] Error stopping proxy server:', e);
    douyuProxyActive = false;
  }
}

function enforceHttps(url: string): string {
  if (!url) return url;
  if (url.startsWith('https://')) return url;
  if (url.startsWith('http://')) {
    return `https://${url.slice('http://'.length)}`;
  }
  return url;
}
