"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useFollow } from "@/state/follow/FollowProvider";
import { refreshFollowedStreamer } from "@/services/followRefresh";
import { FollowRefreshSchedule } from "@/services/followRefreshSchedule";

const schedule = new FollowRefreshSchedule();

export function useFollowRefresh(enabled = true) {
  const follow = useFollow();
  const latest = useRef(follow);
  latest.current = follow;
  const running = useRef(false);
  const generation = useRef(0);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [refreshing, setRefreshing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(schedule.lastStartedAt);

  const refresh = useCallback(async () => {
    if (running.current || !latest.current.hydrated || !enabledRef.current || document.visibilityState !== "visible") return;
    const streamers = [...latest.current.followedStreamers];
    if (!streamers.length) return;
    const token = generation.current;
    running.current = true;
    schedule.started(Date.now());
    setLastRefreshAt(schedule.lastStartedAt);
    setRefreshing(true);
    setProgress({ current: 0, total: streamers.length });
    let cursor = 0;
    let completed = 0;
    try {
      await Promise.all(Array.from({ length: Math.min(2, streamers.length) }, async () => {
        while (cursor < streamers.length && token === generation.current && enabledRef.current && document.visibilityState === "visible") {
          const streamer = streamers[cursor++];
          try {
            const patch = await refreshFollowedStreamer(streamer);
            if (token === generation.current) latest.current.updateStreamer(streamer.platform, streamer.id, patch);
          } catch {
            if (token === generation.current) latest.current.updateStreamer(streamer.platform, streamer.id, { liveStatus: "UNKNOWN", refreshError: true });
          }
          completed++;
          if (token === generation.current) setProgress({ current: completed, total: streamers.length });
        }
      }));
    } finally {
      running.current = false;
      if (token === generation.current) {
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => () => { generation.current++; }, []);

  // Only poll on the visible home page; never run overlapping refresh batches.
  useEffect(() => {
    if (!follow.hydrated || !enabled || refreshing || !follow.followedStreamers.length) return;
    let cancelled = false;
    let timer: number;
    const scheduleNext = () => {
      window.clearTimeout(timer);
      if (cancelled || document.visibilityState !== "visible") return;
      timer = window.setTimeout(async () => {
        if (schedule.delay(Date.now()) === 0) await refresh();
        scheduleNext();
      }, Math.max(250, schedule.delay(Date.now())));
    };
    scheduleNext();
    document.addEventListener("visibilitychange", scheduleNext);
    return () => { cancelled = true; window.clearTimeout(timer); document.removeEventListener("visibilitychange", scheduleNext); };
  }, [enabled, follow.hydrated, follow.followedStreamers.length, lastRefreshAt, refreshing, refresh]);

  return { refresh, refreshing, progress, lastRefreshAt };
}
