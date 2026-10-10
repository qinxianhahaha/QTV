"use client";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import styles from "./Navbar.module.css";

export function DouyinRoomSuggestion({ roomId, onOpen }: { roomId: string; onOpen: () => void }) {
  const [info, setInfo] = useState<{ id: string; name: string; status: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timeout: number;
    const timer = window.setTimeout(() => {
      timeout = window.setTimeout(() => {
        if (!cancelled) setInfo({ id: roomId, name: "抖音直播间", status: "状态暂不可用，可直接打开" });
      }, 15000);
      void invoke<{ anchor_name?: string; title?: string; status?: number; error_message?: string }>("fetch_douyin_streamer_info", {
        payload: { args: { room_id_str: roomId } }
      }).then(data => {
        if (cancelled) return;
        setInfo({ id: roomId, name: data.anchor_name || "抖音直播间", status: data.error_message ? "状态暂不可用" : data.status === 2 ? "直播中" : data.status === 4 ? "未开播" : "可打开查看状态" });
      }).catch(() => { if (!cancelled) setInfo({ id: roomId, name: "抖音直播间", status: "状态暂不可用" }); })
        .finally(() => window.clearTimeout(timeout));
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); window.clearTimeout(timeout); };
  }, [roomId]);
  const current = info?.id === roomId ? info : null;
  return <button type="button" className={styles.roomSuggestion} onMouseDown={e => e.preventDefault()} onClick={onOpen}>
    <strong>{current?.name || "已识别抖音直播间"}</strong>
    <span>{roomId} · {current?.status || "正在检查开播状态…"}</span>
    <em>进入直播间 ↗</em>
  </button>;
}
