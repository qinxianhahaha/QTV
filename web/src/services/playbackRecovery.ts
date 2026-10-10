export type RecoveryState = { phase: 'waiting' | 'scheduled' | 'reconnecting' | 'failed'; attempt: number; max: number } | null;

// One budget covers both URL-fetch failures and media failures. A successful
// HTTP response alone does not reset it: require 20 seconds of advancing video.
export function createPlaybackRecovery(options: {
  retry: (attempt: number) => Promise<void>;
  onState: (state: RecoveryState) => void;
  online: () => boolean;
}) {
  const delays = [1000, 3000, 8000, 15000];
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let deferredFailure = false;
  let waiting = false;
  let stopped = false;
  let generation = 0;
  let stableSince = 0;
  let lastProgress = 0;
  let stateVisible = false;
  const emit = (phase: NonNullable<RecoveryState>['phase']) => {
    stateVisible = true;
    options.onState({ phase, attempt: phase === 'scheduled' ? attempts + 1 : attempts, max: delays.length });
  };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  function fail() {
    if (stopped) return;
    stableSince = 0;
    if (running) { deferredFailure = true; return; }
    if (timer !== undefined) return;
    if (!options.online()) { waiting = true; emit('waiting'); return; }
    waiting = false;
    if (attempts >= delays.length) { emit('failed'); return; }
    emit('scheduled');
    const captured = generation;
    timer = setTimeout(async () => {
      timer = undefined;
      if (stopped || generation !== captured) return;
      if (!options.online()) { waiting = true; emit('waiting'); return; }
      attempts++;
      running = true;
      deferredFailure = false;
      emit('reconnecting');
      try { await options.retry(attempts); } catch { deferredFailure = true; }
      if (stopped || generation !== captured) return;
      running = false;
      if (deferredFailure) { deferredFailure = false; fail(); }
    }, delays[attempts]);
  }
  return {
    fail,
    progress(now = Date.now()) {
      if (stopped || running) return;
      // The player's own recovery may win before our pending retry fires.
      clearTimer();
      waiting = false;
      if (!stableSince || now - lastProgress > 4000) stableSince = now;
      lastProgress = now;
      if (stateVisible) { options.onState(null); stateVisible = false; }
      if (now - stableSince >= 20000) attempts = 0;
    },
    networkChanged() {
      if (stopped) return;
      if (!options.online()) { clearTimer(); waiting = true; emit('waiting'); }
      else if (waiting) { waiting = false; fail(); }
    },
    reset() {
      generation++; clearTimer(); attempts = 0; running = false; deferredFailure = false;
      stableSince = 0; lastProgress = 0; waiting = false; stopped = false;
      if (stateVisible) options.onState(null);
      stateVisible = false;
    },
    stop() { generation++; stopped = true; clearTimer(); },
  };
}
