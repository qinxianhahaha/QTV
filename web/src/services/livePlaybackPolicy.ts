// These options are consumed by the installed danmu.js live queue. Without live
// mode it keeps every past comment and sorts/scans the whole history indefinitely.
export const LIVE_DANMU_OPTIONS = {
  live: true,
  maxCommentsLength: 200,
  dropStaleComments: true,
};

// Keep decoded playback unchanged; only bound data that is already behind live.
export const LIVE_HLS_OPTIONS = {
  enableWorker: true,
  backBufferLength: 15,
};

// xgplayer-hls.js 3.0.24 starts a statistics timer on every URL registration,
// but does not clear it on switch/destroy. Retain its metadata events and API.
export function withHlsTimerCleanup(Base: any) {
  return class ManagedHlsPlugin extends Base {
    _statistics() {
      clearInterval(this._statisticsTimmer);
      super._statistics();
    }

    destroy() {
      clearInterval(this._statisticsTimmer);
      this._statisticsTimmer = undefined;
      super.destroy();
    }
  };
}
