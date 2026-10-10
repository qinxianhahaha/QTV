export type PlaybackStats = {
  width: number; height: number; sourceFps: number | null; playbackFps: number | null;
  codec: string | null; droppedFrames: number; totalFrames: number; bufferedSeconds: number;
};
export const EMPTY_PLAYBACK_STATS: PlaybackStats = {
  width: 0, height: 0, sourceFps: null, playbackFps: null, codec: null,
  droppedFrames: 0, totalFrames: 0, bufferedSeconds: 0,
};
export function codecLabel(codec: string | undefined): string | null {
  if (!codec) return null;
  if (/^(avc|h264)/i.test(codec)) return 'H.264';
  if (/^(hev|hvc|h265)/i.test(codec)) return 'HEVC';
  if (/^(av01|av1)/i.test(codec)) return 'AV1';
  return codec;
}
export function frameRate(value: unknown): number | null {
  const n = typeof value === 'object' && value !== null
    ? Number((value as any).fps ?? (Number((value as any).fpsNum) / Number((value as any).fpsDen)))
    : Number(value);
  return Number.isFinite(n) && n >= 1 && n <= 240 ? Math.round(n * 10) / 10 : null;
}

// One lightweight 1 Hz health sampler; short frame bursts only when diagnostics are visible.
// Native decoded dimensions are authoritative; source fps and presentation fps
// remain separate because a 120 fps source may render at 60 Hz on this screen.
export function watchPlayback(player: any, options: {
  active: () => boolean;
  initial?: { sourceFps?: number | null; sourceCodec?: string | null };
  stats: (value: PlaybackStats) => void;
  progress: () => void;
  pause?: () => void;
  measureFrames?: () => boolean;
  failure: (codecFailure: boolean) => void;
}) {
  const video = player.video as HTMLVideoElement;
  if (!video) return () => {};
  let state = { ...EMPTY_PLAYBACK_STATS, sourceFps: options.initial?.sourceFps || null, codec: codecLabel(options.initial?.sourceCodec || undefined) };
  let lastTime = video.currentTime || 0;
  let lastAdvance = Date.now();
  let everPlayed = false;
  let previousFrames = 0;
  let previousSample = Date.now();
  const supportsFrameCallback = typeof video.requestVideoFrameCallback === 'function';
  let frameCallback: number | null = null;
  let lastBurst = 0;
  let disposed = false;
  const error = (e: any) => {
    if (!disposed && options.active()) {
      const text = `${e?.message || ''} ${e?.errorDetails || ''} ${e?.errorType || ''}`;
      options.failure(video.error?.code === 3 || video.error?.code === 4 || /codec|decode|mediaError|hev1|hvc1|hevc|h265|not.?supported|mse/i.test(text));
    }
  };
  const hlsError = (e: any) => { if (e?.errorFatal) error(e); };
  const pause = () => {
    if (!disposed && options.active() && everPlayed && !video.error && !video.ended && video.readyState >= 2) options.pause?.();
  };
  const info = (e: any) => {
    state.codec = codecLabel(e?.videoCodec) || state.codec;
    state.sourceFps = frameRate(e?.fps) || state.sourceFps;
  };
  const core = (e: any) => {
    if (e?.eventName === 'core.metadataparsed' && e?.type === 'video') {
      state.codec = codecLabel(e.meta?.codec) || state.codec;
      state.sourceFps = frameRate(e.meta?.fps ?? e.meta?.frameRate ?? e.track) || state.sourceFps;
    }
    if (e?.eventName === 'core.flvscriptdata') {
      state.sourceFps = frameRate(e?.data?.onMetaData?.framerate ?? e?.onMetaData?.framerate ?? e?.data?.framerate) || state.sourceFps;
    }
  };
  player.on?.('error', error);
  player.on?.('HLS_ERROR', hlsError);
  player.on?.('media_info', info);
  player.on?.('core_event', core);
  video.addEventListener('error', error);
  video.addEventListener('pause', pause);
  const timer = setInterval(() => {
    if (disposed || !options.active()) return;
    const now = Date.now();
    const advancing = video.currentTime > lastTime + 0.01;
    if (advancing) {
      everPlayed = true; lastAdvance = now; options.progress();
    } else if (video.paused && !video.ended && !video.error && (everPlayed || video.readyState >= 2)) {
      // User pause/autoplay policy is not a failed stream.
      lastAdvance = now;
    } else if (document.visibilityState !== 'hidden' && now - lastAdvance > (everPlayed ? 15000 : 30000)) {
      lastAdvance = now; options.failure(false);
    }
    lastTime = video.currentTime;
    state.width = video.videoWidth || 0;
    state.height = video.videoHeight || 0;
    const quality = video.getVideoPlaybackQuality?.();
    const total = quality?.totalVideoFrames ?? (video as any).webkitDecodedFrameCount ?? 0;
    const dropped = quality?.droppedVideoFrames ?? (video as any).webkitDroppedFrameCount ?? 0;
    const shown = Math.max(0, total - dropped);
    const measure = advancing && document.visibilityState !== 'hidden' && (options.measureFrames?.() ?? true);
    // WebKit's native HLS counters can count display repeats, while its
    // presentedFrames counter may count only registered callbacks. Use a short
    // consecutive burst and count distinct media times instead. Never run this
    // animation callback loop while the diagnostics panel is closed/hidden.
    if (!measure || (frameCallback !== null && now - lastBurst > 2500)) {
      if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
      frameCallback = null;
      state.playbackFps = null;
      if (!measure) lastBurst = 0;
    } else if (supportsFrameCallback && frameCallback === null && (!lastBurst || now - lastBurst >= 5000)) {
      lastBurst = now;
      let firstTime: number | null = null;
      let lastMediaTime = -1;
      let intervals = 0;
      const sample = (time: number, metadata: VideoFrameCallbackMetadata) => {
        frameCallback = null;
        if (disposed || !options.active() || !(options.measureFrames?.() ?? true) || document.visibilityState === 'hidden') return;
        if (firstTime === null) { firstTime = time; lastMediaTime = metadata.mediaTime; }
        else if (metadata.mediaTime > lastMediaTime + 0.00001) { intervals++; lastMediaTime = metadata.mediaTime; }
        const elapsed = time - firstTime;
        if (intervals >= 24 || elapsed >= 1500) {
          const fps = frameRate(intervals * 1000 / Math.max(1, elapsed));
          state.playbackFps = fps ? Math.round(fps) : null;
          options.stats({ ...state });
        } else { frameCallback = video.requestVideoFrameCallback(sample); }
      };
      frameCallback = video.requestVideoFrameCallback(sample);
    } else if (!supportsFrameCallback && measure && shown >= previousFrames) {
      state.playbackFps = frameRate((shown - previousFrames) * 1000 / Math.max(1, now - previousSample));
    }
    previousFrames = shown; previousSample = now;
    state.totalFrames = total; state.droppedFrames = dropped;
    state.bufferedSeconds = 0;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= video.currentTime && video.buffered.end(i) >= video.currentTime) {
        state.bufferedSeconds = Math.round((video.buffered.end(i) - video.currentTime) * 10) / 10;
      }
    }
    if (document.visibilityState !== 'hidden') options.stats({ ...state });
  }, 1000);
  return () => {
    disposed = true; clearInterval(timer);
    if (frameCallback !== null) video.cancelVideoFrameCallback?.(frameCallback);
    frameCallback = null;
    player.off?.('error', error); player.off?.('HLS_ERROR', hlsError);
    player.off?.('media_info', info); player.off?.('core_event', core);
    video.removeEventListener('error', error);
    video.removeEventListener('pause', pause);
  };
}

let hevcCapability: Promise<boolean> | undefined;
export function supportsEfficientHevc(): Promise<boolean> {
  return hevcCapability ??= (async () => {
    if (typeof MediaSource === 'undefined' || !navigator.mediaCapabilities?.decodingInfo) return false;
    for (const codec of ['hvc1.1.6.L156.B0', 'hev1.1.6.L156.B0']) {
      const contentType = `video/mp4; codecs="${codec}"`;
      if (!MediaSource.isTypeSupported(contentType)) continue;
      try {
        const result = await navigator.mediaCapabilities.decodingInfo({
          type: 'media-source', video: { contentType, width: 2560, height: 1440, bitrate: 20000000, framerate: 120 },
        });
        if (result.supported && result.smooth && result.powerEfficient) return true;
      } catch { /* Unsupported capability queries keep the compatible AVC path. */ }
    }
    return false;
  })();
}
