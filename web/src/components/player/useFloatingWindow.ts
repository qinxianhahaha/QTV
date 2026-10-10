"use client";

import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { createSerialTaskQueue } from "@/services/serialTaskQueue";

const enqueue = createSerialTaskQueue();
type WindowSnapshot = { width: number };

async function readSnapshot(): Promise<WindowSnapshot> {
  const win = getCurrentWindow();
  const [size, scale] = await Promise.all([win.innerSize(), win.scaleFactor()]);
  return { width: size.toLogical(scale).width };
}

async function restoreWindow(snapshot: WindowSnapshot, pinned: boolean) {
  const win = getCurrentWindow();
  if (pinned) await win.setAlwaysOnTop(false);
  await win.setDecorations(true);
  if (/Mac/i.test(navigator.platform)) await win.setTitleBarStyle("overlay");
  // AppKit applies size, centered position, minimum size and aspect in one frame.
  await invoke("set_playback_layout", { width: snapshot.width, compact: false, center: true });
}

export function useFloatingWindow() {
  const [ready, setReady] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [compact, setCompact] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const snapshotRef = useRef<WindowSnapshot | null>(null);
  const sessionRef = useRef(0);
  const busyRef = useRef(false);
  const closingRef = useRef(false);
  const modeRef = useRef({ compact: false, pinned: false });

  async function restoreCompactWindow() {
    if (!modeRef.current.compact || !snapshotRef.current) return;
    await restoreWindow(snapshotRef.current, modeRef.current.pinned);
    modeRef.current = { compact: false, pinned: false };
  }

  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    const session = ++sessionRef.current;
    busyRef.current = false;
    closingRef.current = false;
    void enqueue(async () => {
      const snapshot = await readSnapshot();
      if (sessionRef.current !== session) return;
      snapshotRef.current = snapshot;
      setReady(true);
    }).catch(() => { if (sessionRef.current === session) setError("窗口控制暂不可用"); });
    return () => {
      sessionRef.current++;
      // Fallback for route changes. A normal close has already restored the window.
      // Closing a full-size player performs no redundant resize or recentering.
      void enqueue(async () => {
        await restoreCompactWindow();
        snapshotRef.current = null;
      }).catch(console.error);
    };
  }, []);

  async function change(action: () => Promise<void>) {
    if (!ready || busyRef.current || closingRef.current) return;
    const session = sessionRef.current;
    busyRef.current = true;
    setBusy(true); setError("");
    try { await enqueue(async () => { if (sessionRef.current === session) await action(); }); }
    catch (e) {
      if (sessionRef.current === session) {
        setCompact(modeRef.current.compact);
        setError(e instanceof Error ? e.message : "窗口操作失败，请重试");
      }
    } finally {
      if (sessionRef.current === session && !closingRef.current) { busyRef.current = false; setBusy(false); }
    }
  }

  async function restoreForClose(): Promise<boolean> {
    if (closingRef.current) return false;
    closingRef.current = true;
    const session = sessionRef.current;
    setBusy(true);
    try {
      await enqueue(restoreCompactWindow);
      return sessionRef.current === session;
    } catch {
      closingRef.current = false;
      busyRef.current = false;
      setBusy(false);
      setError("恢复主界面失败，请重试");
      return false;
    }
  }

  return { ready, pinned, compact, busy, error, restoreForClose,
    togglePin: () => change(async () => {
      if (!modeRef.current.compact) return;
      const next = !modeRef.current.pinned;
      await getCurrentWindow().setAlwaysOnTop(next);
      modeRef.current.pinned = next;
      setPinned(next);
    }),
    toggleCompact: (anchor: { x: number; y: number }) => change(async () => {
      const win = getCurrentWindow();
      if (!modeRef.current.compact) {
        if (await win.isFullscreen()) throw new Error("请先退出全屏，再切换小窗");
        // Remember the latest user-resized 16:9 home size, not only the launch size.
        snapshotRef.current = await readSnapshot();
        modeRef.current.compact = true;
        try {
          if (await win.isMaximized()) await win.unmaximize();
          await win.setDecorations(false);
          await invoke("set_playback_layout", { width: 640, compact: true, center: false, anchorX: anchor.x, anchorY: anchor.y });
          setCompact(true);
        } catch (e) {
          await restoreCompactWindow();
          throw e;
        }
      } else {
        await restoreCompactWindow();
        setPinned(false);
        setCompact(false);
      }
    })
  };
}
