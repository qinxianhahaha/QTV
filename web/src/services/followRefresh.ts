import { invoke } from "@tauri-apps/api/core";
import type { FollowedStreamer } from "@/state/follow/FollowProvider";

const text = (...values: unknown[]) => values.find(v => typeof v === "string" && v.trim()) as string | undefined;
const number = (v: unknown) => v === null || v === undefined || v === "" ? null : Number.isFinite(Number(v)) ? Number(v) : null;

/** Missing/error responses must not silently turn a live room into an offline room. */
export function normalizeFollowInfo(streamer: FollowedStreamer, info: Record<string, unknown>): Partial<FollowedStreamer> {
  if (!info || info.error_message) throw new Error(String(info?.error_message || "房间信息暂时不可用"));
  let liveStatus: FollowedStreamer["liveStatus"] = "UNKNOWN";
  if (streamer.platform === "DOUYU") {
    const status = number(info.show_status);
    const loop = number(info.video_loop ?? info.videoLoop);
    if (status === 1 && loop === 0) liveStatus = "LIVE";
    else if (status === 2 || status === 0 || (status === 1 && loop === 1)) liveStatus = "OFFLINE";
  } else if (streamer.platform === "HUYA") {
    if (info.is_live === true) liveStatus = "LIVE";
    else if (info.is_live === false) liveStatus = "OFFLINE";
  } else {
    const status = number(info.status);
    if (status !== null) liveStatus = status === (streamer.platform === "DOUYIN" ? 2 : 1) ? "LIVE" : "OFFLINE";
  }
  if (liveStatus === "UNKNOWN") throw new Error("未能确认开播状态");
  return {
    nickname: text(info.nickname, info.anchor_name, info.nick) || streamer.nickname,
    avatarUrl: text(info.avatar_url, info.avatar) || streamer.avatarUrl,
    roomTitle: text(info.room_name, info.title) || streamer.roomTitle,
    // Do not carry yesterday's cover into a new stream if the API has no current cover.
    coverUrl: liveStatus === "LIVE" ? text(info.cover_url) || "" : "",
    liveStatus,
    lastCheckedAt: Date.now(),
    refreshError: false
  };
}

export async function refreshFollowedStreamer(streamer: FollowedStreamer): Promise<Partial<FollowedStreamer>> {
  let request: Promise<Record<string, unknown>>;
  if (streamer.platform === "DOUYU") request = invoke("fetch_douyu_room_info", { roomId: streamer.id });
  else if (streamer.platform === "HUYA") request = invoke("get_huya_unified_cmd", { roomId: streamer.id, quality: null, line: null });
  else {
    const payload = { platform: streamer.platform, args: { room_id_str: streamer.id } };
    request = streamer.platform === "BILIBILI"
      ? invoke("fetch_bilibili_streamer_info", { payload, cookie: window.localStorage.getItem("bilibili_cookie") || null })
      : invoke("fetch_douyin_streamer_info", { payload });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const info = await Promise.race([request, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("刷新超时")), 20000); })]);
    return normalizeFollowInfo(streamer, info);
  } finally { clearTimeout(timer); }
}
