export const FOLLOW_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

/** One schedule per app session, shared when the home page is remounted. */
export class FollowRefreshSchedule {
  lastStartedAt: number | null = null;

  delay(now: number): number {
    if (this.lastStartedAt === null) return 0;
    return Math.max(0, FOLLOW_REFRESH_INTERVAL_MS - (now - this.lastStartedAt));
  }

  started(now: number) {
    this.lastStartedAt = now;
  }
}
