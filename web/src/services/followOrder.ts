type StreamerIdentity = { platform: string; id: string };
const keyOf = (streamer: StreamerIdentity) => `${streamer.platform}:${streamer.id}`;

/** Move existing objects, preserving the latest metadata and every other follow. */
export function moveFollowedStreamer<T extends StreamerIdentity>(streamers: T[], sourceKey: string, targetKey: string): T[] {
  const from = streamers.findIndex(s => keyOf(s) === sourceKey);
  const to = streamers.findIndex(s => keyOf(s) === targetKey);
  if (from < 0 || to < 0 || from === to) return streamers;
  const next = [...streamers];
  const [streamer] = next.splice(from, 1);
  next.splice(to, 0, streamer);
  return next;
}
