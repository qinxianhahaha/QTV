export type TrafficSample = {
  bytesPerSecond: number | null;
  averageBytesPerSecond: number | null;
  totalBytes: number | null;
};
export const EMPTY_TRAFFIC: TrafficSample = { bytesPerSecond: null, averageBytesPerSecond: null, totalBytes: null };

// Each media relay owns its counter, so room/quality changes cannot mix streams.
// Never probe a remote CDN or include image/chat traffic in the measurement.
export function mediaTrafficUrl(mediaUrl: string | null): string | null {
  if (!mediaUrl) return null;
  try {
    const url = new URL(mediaUrl);
    const prefix = url.pathname.split('/')[1];
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !/^[a-zA-Z0-9]{32}$/.test(prefix)) return null;
    url.pathname = `/${prefix}/traffic`;
    url.search = ''; url.hash = '';
    return url.href;
  } catch { return null; }
}

export function createTrafficSampler() {
  let samples: { bytes: number; time: number }[] = [];
  return (bytes: number, time: number): TrafficSample => {
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isFinite(time)) {
      samples = []; return { ...EMPTY_TRAFFIC };
    }
    let previous = samples.at(-1);
    if (previous && (bytes < previous.bytes || time <= previous.time)) {
      samples = []; previous = undefined;
    }
    samples.push({ bytes, time });
    // Keep a baseline just outside the last ten seconds for bursty HLS loads.
    while (samples.length > 2 && samples[1].time <= time - 10000) samples.shift();
    const first = samples[0];
    return {
      bytesPerSecond: previous ? (bytes - previous.bytes) * 1000 / (time - previous.time) : null,
      averageBytesPerSecond: previous ? (bytes - first.bytes) * 1000 / (time - first.time) : null,
      totalBytes: bytes,
    };
  };
}

// Decimal units match ISP Mbps: 1 MB/s = 8 Mbps.
export function formatTrafficBytes(bytes: number | null, perSecond = false): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return '—';
  const unit = bytes >= 1e9 ? 'GB' : bytes >= 1e6 ? 'MB' : bytes >= 1e3 ? 'KB' : 'B';
  const divisor = unit === 'GB' ? 1e9 : unit === 'MB' ? 1e6 : unit === 'KB' ? 1e3 : 1;
  return `${(bytes / divisor).toFixed(unit === 'B' ? 0 : unit === 'KB' ? 0 : 2)} ${unit}${perSecond ? '/s' : ''}`;
}

export function watchMediaTraffic(url: string, update: (sample: TrafficSample) => void) {
  let disposed = false;
  let pending: AbortController | null = null;
  let sample = createTrafficSampler();
  const poll = async () => {
    if (disposed || pending) return;
    const controller = new AbortController();
    pending = controller;
    const timeout = setTimeout(() => controller.abort(), 2500);
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
      if (!response.ok) throw new Error('Traffic unavailable');
      const { totalBytes } = await response.json();
      if (!disposed) update(sample(totalBytes, Date.now()));
    } catch {
      sample = createTrafficSampler();
      if (!disposed) update({ ...EMPTY_TRAFFIC });
    } finally {
      clearTimeout(timeout);
      if (pending === controller) pending = null;
    }
  };
  void poll();
  const timer = setInterval(() => void poll(), 1000);
  return () => { disposed = true; clearInterval(timer); pending?.abort(); };
}
