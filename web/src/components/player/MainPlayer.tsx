"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pin, PinOff, Minimize2, Maximize2, ChevronUp, ChevronDown } from "lucide-react";
import { BilibiliCookieControls } from "@/components/bilibili/BilibiliCookieControls";
import { DouyuLoginControls } from "./DouyuLoginControls";
import { useFloatingWindow } from "./useFloatingWindow";
import { useRouter } from "next/navigation";
import { listen, type Event as TauriEvent } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { v4 as uuidv4 } from "uuid";
import { AnimatePresence, m } from "framer-motion";
import { POSITIONS } from "xgplayer/es/plugin/plugin.js";

import "xgplayer/dist/index.min.css";
import "./player.css";

import type { DanmakuMessage, DanmuOverlayInstance, RustGetStreamUrlPayload } from "@/components/player/types";
import type { DanmuKeywordBlockPreferences, DanmuUserSettings } from "@/components/player/constants";
import {
  applyDanmuFontFamilyForOS,
  DANMU_BLOCK_KEYWORDS_CHANGED_EVENT,
  ICONS,
  loadDanmuKeywordBlockPreferences,
  loadDanmuPreferences,
  loadStoredVolume,
  persistDanmuKeywordBlockPreferences,
  persistDanmuPreferences,
  sanitizeDanmuArea,
  sanitizeDanmuOpacity
} from "@/components/player/constants";
import { arrangeControlClusters } from "@/components/player/controlLayout";
import { Platform } from "@/platforms/common/types";
import { getDouyuStreamConfig, stopDouyuProxy } from "@/platforms/douyu/playerHelper";
import { stopHuyaProxy } from "@/platforms/huya/playerHelper";
import { fetchAndPrepareDouyinStreamConfig } from "@/platforms/douyin/playerHelper";
import { getHuyaStreamConfig } from "@/platforms/huya/playerHelper";
import { getBilibiliStreamConfig } from "@/platforms/bilibili/playerHelper";
import { useImageProxy } from "@/hooks/useImageProxy";
import { useFollow, type FollowedStreamer, type Platform as FollowPlatform } from "@/state/follow/FollowProvider";
import { usePlayerUi } from "@/state/playerUi/PlayerUiProvider";
import { createSerialTaskQueue } from "@/services/serialTaskQueue";
import { adjacentFollowRoom } from "@/services/followNavigation";
import { isConfirmedOfflineError } from "@/services/playerError";
import { LIVE_HLS_OPTIONS, withHlsTimerCleanup } from "@/services/livePlaybackPolicy";

import { PlaybackInfo } from './PlaybackInfo';
import { createPlaybackRecovery, type RecoveryState } from '@/services/playbackRecovery';
import { watchPlayback, supportsEfficientHevc, EMPTY_PLAYBACK_STATS, type PlaybackStats } from '@/services/playbackTelemetry';

type ReloadTrigger = "refresh" | "quality" | "line" | "recovery";
type ReloadOverrides = { quality?: string; line?: string | null; attempt?: number };

const enqueuePlayback = createSerialTaskQueue();

declare global {
  // Used to guard against React StrictMode(dev) mount/unmount cycles accidentally stopping a newer player session.
  // eslint-disable-next-line no-var
  var __QTV_PLAYER_MOUNT_GEN: number | undefined;
}

const qualityOptions = ["原画", "高清", "标清"] as const;

const PLAYER_DRAG_EXCLUDED_SELECTOR = [
  // App chrome / topbar (主播信息栏 & 关闭/关注按钮等)
  ".player-window-controls",
  // Stream error overlay (中间刷新按钮)
  ".retry-btn",
  ".playback-info",
  // Generic interactive elements
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "[role='button']:not(.xgplayer)",
  "[role='link']",
  "[contenteditable='true']",
  // xgplayer controls / popups (播放器控制栏及其菜单)
  ".xgplayer-controls",
  ".xgplayer-controls *",
  ".xgplayer-danmu-block-panel",
  ".xgplayer-danmu-settings-panel",
  ".xgplayer-quality-dropdown",
  ".xgplayer-line-dropdown"
].join(", ");

const DEFAULT_DANMU_SETTINGS: DanmuUserSettings = {
  color: "#ffffff",
  strokeColor: "#444444",
  fontSize: "20px",
  duration: 10000,
  area: 0.5,
  mode: "scroll",
  opacity: 1
};

function resolveStoredQuality(platform: Platform) {
  try {
    const saved = window.localStorage.getItem(`${platform}_preferred_quality`);
    if (saved && (qualityOptions as readonly string[]).includes(saved)) return saved;
  } catch {
    // ignore
  }
  return "原画";
}

function isOfflineMessage(msg: string) {
  const s = (msg || "").toLowerCase();
  return s.includes("未开播") || s.includes("主播未开播") || s.includes("房间不存在");
}

function supportsMseType(mime: string) {
  try {
    return typeof MediaSource !== "undefined" && typeof MediaSource.isTypeSupported === "function" && MediaSource.isTypeSupported(mime);
  } catch {
    return false;
  }
}

function maybeAppendHevcInstallHint(rawMessage: string) {
  const msg = String(rawMessage || "");
  const lower = msg.toLowerCase();
  const looksLikeHevcCodecUnsupported =
    (lower.includes("video/mp4") && (lower.includes("hev1") || lower.includes("hvc1"))) ||
    lower.includes("hevc") ||
    lower.includes("h.265") ||
    lower.includes("h265");
  if (!looksLikeHevcCodecUnsupported) return msg;

  const hev1 = 'video/mp4; codecs="hev1.1.6.L93.B0"';
  const hvc1 = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
  const hev1Supported = supportsMseType(hev1);
  const hvc1Supported = supportsMseType(hvc1);

  if (!hev1Supported && !hvc1Supported) {
    return `${msg}\n\n提示：检测到当前环境不支持 HEVC(H.265) 解码（hev1/hvc1 均不支持）。\n请安装 Microsoft.HEVCVideoExtension 插件后重启软件。\n下载地址：https://github.com/qinxianhahaha/QTV/releases\n（按 release 提示下载并安装对应插件）`;
  }

  return msg;
}

type UnifiedRustDanmakuPayload = {
  room_id?: string;
  user: string;
  content: string;
  user_level: number;
  fans_club_level: number;
};

type LineOption = { key: string; label: string };
const lineOptionsByPlatform: Partial<Record<Platform, LineOption[]>> = {
  [Platform.DOUYU]: [
    { key: "ws-h5", label: "主线路" },
    { key: "tct-h5", label: "线路5" },
    { key: "ali-h5", label: "线路6" },
    { key: "hs-h5", label: "线路13" }
  ],
  [Platform.HUYA]: [
    { key: "tx", label: "腾讯线路" },
    { key: "al", label: "阿里线路" },
    { key: "hs", label: "字节线路" }
  ]
};

function resolveStoredLine(platform: Platform, options: LineOption[]) {
  if (!options.length) return null;
  try {
    const saved = window.localStorage.getItem(`${platform}_preferred_line`);
    if (saved && options.some((o) => o.key === saved)) return saved;
  } catch {
    // ignore
  }
  return options[0]?.key ?? null;
}

function persistLinePreference(platform: Platform, lineKey: string) {
  try {
    window.localStorage.setItem(`${platform}_preferred_line`, lineKey);
  } catch {
    // ignore
  }
}

function resolveCurrentLineFor(options: LineOption[], currentLine: string | null) {
  if (!options.length) return null;
  if (currentLine && options.some((o) => o.key === currentLine)) return currentLine;
  return options[0]?.key ?? null;
}

export function MainPlayer({
  platform,
  roomId,
  onRequestClose,
  onRequestSwitch
}: {
  platform: Platform;
  roomId: string;
  onRequestClose?: () => void;
  onRequestSwitch?: (room: { platform: string; roomId: string }) => void;
}) {
  const router = useRouter();
  const follow = useFollow();
  const { setIsland, clearIsland, setFullscreen } = usePlayerUi();
  const { ensureProxyStarted, getAvatarSrc } = useImageProxy();
  const pageRef = useRef<HTMLDivElement | null>(null);

  const playerContainerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<any>(null);
  const playbackKindRef = useRef<null | "hls" | "native-hls" | "flv">(null);
  const danmuOverlayRef = useRef<DanmuOverlayInstance | null>(null);
  const unlistenRef = useRef<null | (() => void)>(null);
  const danmakuTargetRef = useRef<null | [number, DanmuOverlayInstance | null, Platform, string, string?]>(null);

  const disposedRef = useRef(false);
  const activeSessionIdRef = useRef(0);
  const sessionSeqRef = useRef(0);
  const mountGenRef = useRef(0);

  const switchPendingRef = useRef(false);
  const [isSwitchingRoom, setIsSwitchingRoom] = useState(false);
  const previousFollow = adjacentFollowRoom(follow.followedStreamers, platform, roomId, -1);
  const nextFollow = adjacentFollowRoom(follow.followedStreamers, platform, roomId, 1);
  useEffect(() => {
    switchPendingRef.current = false;
    setIsSwitchingRoom(false);
  }, [platform, roomId]);

  const switchFollowRoom = (direction: -1 | 1) => {
    if (switchPendingRef.current) return;
    const target = adjacentFollowRoom(follow.followedStreamers, platform, roomId, direction);
    if (!target) return;
    switchPendingRef.current = true;
    setIsSwitchingRoom(true);
    const next = { platform: target.platform.toLowerCase(), roomId: target.id };
    if (onRequestSwitch) onRequestSwitch(next);
    else router.replace(`/player?${new URLSearchParams(next)}`);
  };

  const refreshPluginRef = useRef<any>(null);
  const volumePluginRef = useRef<any>(null);
  const danmuTogglePluginRef = useRef<any>(null);
  const danmuSettingsPluginRef = useRef<any>(null);
  const danmuKeywordBlockPluginRef = useRef<any>(null);
  const qualityPluginRef = useRef<any>(null);
  const actualQualityRef = useRef<string | null>(null);
  const [qualityNotice, setQualityNotice] = useState<string | null>(null);
  const linePluginRef = useRef<any>(null);
  const hevcBrandPatchedRef = useRef(false);
  const recoveryRef = useRef<ReturnType<typeof createPlaybackRecovery> | null>(null);
  const watchCleanupRef = useRef<(() => void) | null>(null);
  const playbackInfoOpenRef = useRef(false);
  const statsRef = useRef<PlaybackStats>({ ...EMPTY_PLAYBACK_STATS });
  const sourceInfoRef = useRef<{ sourceFps?: number | null; sourceCodec?: string | null }>({});
  const forceAvcRef = useRef(false);
  const forceMseRef = useRef(false);
  const lastPlaybackErrorRef = useRef<string | null>(null);
  const [recoveryState, setRecoveryState] = useState<RecoveryState>(null);
  const [actualLine, setActualLine] = useState<string | null>(null);
  const [playbackEngine, setPlaybackEngine] = useState<string | null>(null);

  const [isLoadingStream, setIsLoadingStream] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [isOfflineError, setIsOfflineError] = useState(false);
  const [isFullScreen, setIsFullScreen] = useState(false);

  const [playerTitle, setPlayerTitle] = useState<string | null>(null);
  const [playerAnchorName, setPlayerAnchorName] = useState<string | null>(null);
  const [playerAvatar, setPlayerAvatar] = useState<string | null>(null);
  const [playerIsLive, setPlayerIsLive] = useState<boolean | null>(null);
  const [isWindows, setIsWindows] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const lineOptions: LineOption[] = useMemo(() => lineOptionsByPlatform[platform] ?? [], [platform]);
  const [currentQuality, setCurrentQuality] = useState<string>(() =>
    typeof window === "undefined" ? "原画" : resolveStoredQuality(platform)
  );
  const [currentLine, setCurrentLine] = useState<string | null>(() =>
    typeof window === "undefined" ? null : resolveStoredLine(platform, lineOptionsByPlatform[platform] ?? [])
  );
  const currentQualityRef = useRef(currentQuality);
  const currentLineRef = useRef(currentLine);
  const lineOptionsRef = useRef<LineOption[]>(lineOptions);
  currentQualityRef.current = currentQuality;
  currentLineRef.current = currentLine;
  lineOptionsRef.current = lineOptions;

  const [isDanmuEnabled, setIsDanmuEnabled] = useState(() => {
    if (typeof window === "undefined") return true;
    const stored = loadDanmuPreferences();
    return stored?.enabled ?? true;
  });
  const [pageVisible, setPageVisible] = useState(() => typeof document === "undefined" || document.visibilityState !== "hidden");
  const danmuEnabledRef = useRef(isDanmuEnabled);
  danmuEnabledRef.current = isDanmuEnabled;
  const receiveDanmuRef = useRef(isDanmuEnabled && pageVisible);
  receiveDanmuRef.current = isDanmuEnabled && pageVisible;
  useEffect(() => {
    const onVisibility = () => setPageVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);
  const [danmuSettings, setDanmuSettings] = useState<DanmuUserSettings>(() => {
    if (typeof window === "undefined") return DEFAULT_DANMU_SETTINGS;
    const stored = loadDanmuPreferences();
    return stored?.settings ?? DEFAULT_DANMU_SETTINGS;
  });
  const [danmuKeywordBlock, setDanmuKeywordBlock] = useState<DanmuKeywordBlockPreferences>(() => {
    if (typeof window === "undefined") return { enabled: true, keywords: [] };
    const loaded = loadDanmuKeywordBlockPreferences();
    return loaded ? { enabled: true, keywords: loaded.keywords } : { enabled: true, keywords: [] };
  });
  const danmuKeywordBlockPrefsRef = useRef<DanmuKeywordBlockPreferences>(danmuKeywordBlock);
  useEffect(() => {
    danmuKeywordBlockPrefsRef.current = danmuKeywordBlock;
  }, [danmuKeywordBlock]);

  const danmuKeywordBlockRef = useRef<{ keywordsLower: string[] }>({ keywordsLower: [] });
  useEffect(() => {
    danmuKeywordBlockRef.current = {
      keywordsLower: (danmuKeywordBlock.keywords ?? []).map((k) => String(k || "").trim().toLowerCase()).filter(Boolean)
    };
  }, [danmuKeywordBlock.keywords]);

  useEffect(() => {
    const keywordsEqual = (left: string[], right: string[]) => {
      if (left === right) return true;
      if (left.length !== right.length) return false;
      for (let i = 0; i < left.length; i += 1) {
        if (left[i] !== right[i]) return false;
      }
      return true;
    };

    const onKeywordsChanged = () => {
      const next = loadDanmuKeywordBlockPreferences();
      const nextKeywords = next?.keywords ?? [];
      setDanmuKeywordBlock((prev) => {
        const prevKeywords = prev.keywords ?? [];
        if (keywordsEqual(prevKeywords, nextKeywords)) {
          return prev;
        }
        return { enabled: true, keywords: nextKeywords };
      });
    };

    window.addEventListener(DANMU_BLOCK_KEYWORDS_CHANGED_EVENT, onKeywordsChanged as EventListener);
    return () => window.removeEventListener(DANMU_BLOCK_KEYWORDS_CHANGED_EVENT, onKeywordsChanged as EventListener);
  }, []);

  const [chromeVisible, setChromeVisible] = useState(true);
  const hideChromeTimerRef = useRef<number | null>(null);
  const moveRafRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const osMod: any = await import("@tauri-apps/plugin-os");
        const p = typeof osMod?.platform === "function" ? await osMod.platform() : "";
        if (cancelled) return;
        const platform = String(p).toLowerCase();
        setIsWindows(platform === "windows" || platform === "linux");
      } catch {
        // non-tauri env: ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!isWindows) return;
    let cancelled = false;
    let unlisten: null | (() => void) = null;
    (async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        try {
          const max = await win.isMaximized();
          if (!cancelled) setIsMaximized(!!max);
        } catch {
          // ignore
        }
        try {
          unlisten = await win.onResized(async () => {
            try {
              const max = await win.isMaximized();
              setIsMaximized(!!max);
            } catch {
              // ignore
            }
          });
        } catch {
          // ignore
        }
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
      try {
        unlisten?.();
      } catch {
        // ignore
      }
    };
  }, [isWindows]);

  const minimizeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().minimize();
    } catch {
      // ignore
    }
  }, []);

  const toggleMaximizeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      const max = await win.isMaximized();
      if (max) await win.unmaximize();
      else await win.maximize();
      setIsMaximized(!max);
    } catch {
      // ignore
    }
  }, []);

  const closeWindow = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch {
      // ignore
    }
  }, []);

  const startWindowDragging = useCallback(async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().startDragging();
    } catch {
      // ignore
    }
  }, []);

  const isDragExcludedTarget = useCallback((target: HTMLElement) => {
    return !!target.closest(PLAYER_DRAG_EXCLUDED_SELECTOR);
  }, []);

  const onPlayerPointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0 || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || isFullScreen) return;
      const target = e.target as HTMLElement | null;
      if (!target || isDragExcludedTarget(target)) return;
      // AppKit requires the original mouse-down event to start a native drag.
      // Deferring until pointermove loses that event, especially over letterboxed video.
      void startWindowDragging();
    },
    [isDragExcludedTarget, isFullScreen, startWindowDragging]
  );

  useEffect(() => {
    const armHide = () => {
      if (hideChromeTimerRef.current) window.clearTimeout(hideChromeTimerRef.current);
      hideChromeTimerRef.current = window.setTimeout(() => {
        try {
          const root = pageRef.current;
          const active = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
          const hasOpenMenu = !!root?.querySelector?.(
            ".xgplayer-danmu-block.menu-open, .xgplayer-danmu-settings.menu-open, .xgplayer-quality-control.menu-open, .xgplayer-line-control.menu-open, .playback-info[open]"
          );
          const isEditingInPopup =
            !!active &&
            !!root &&
            root.contains(active) &&
            !!active.closest?.(
              ".xgplayer-danmu-block-panel, .xgplayer-danmu-settings-panel, .xgplayer-quality-dropdown, .xgplayer-line-dropdown"
            );

          if (hasOpenMenu || isEditingInPopup) {
            setChromeVisible(true);
            armHide();
            return;
          }
        } catch {
          // ignore
        }
        setChromeVisible(false);
      }, 2000);
    };

    // Start hidden-after-idle behavior immediately on mount.
    setChromeVisible(true);
    armHide();

    const onMove = () => {
      if (moveRafRef.current) return;
      moveRafRef.current = window.requestAnimationFrame(() => {
        moveRafRef.current = 0;
        setChromeVisible(true);
        armHide();
      });
    };

    const onLeave = () => {
      if (hideChromeTimerRef.current) window.clearTimeout(hideChromeTimerRef.current);
      if (moveRafRef.current) window.cancelAnimationFrame(moveRafRef.current);
      moveRafRef.current = 0;
      setChromeVisible(false);
    };
    const onKey = () => { setChromeVisible(true); armHide(); };
    document.documentElement.addEventListener("mouseleave", onLeave);
    window.addEventListener("blur", onLeave);
    // Capture before player plugins handle shortcuts or stop event propagation.
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousemove", onMove, { passive: true, capture: true });
    window.addEventListener("pointermove", onMove, { passive: true, capture: true });
    return () => {
      document.documentElement.removeEventListener("mouseleave", onLeave);
      window.removeEventListener("blur", onLeave);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("pointermove", onMove, true);
      if (hideChromeTimerRef.current) window.clearTimeout(hideChromeTimerRef.current);
      if (moveRafRef.current) window.cancelAnimationFrame(moveRafRef.current);
      hideChromeTimerRef.current = null;
      moveRafRef.current = 0;
    };
  }, []);

  const floating = useFloatingWindow();
  const requestClose = async () => {
    if (!await floating.restoreForClose()) return;
    if (onRequestClose) onRequestClose();
    else router.back();
  };
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    const onEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.repeat) return;
      const target = event.target as HTMLElement | null;
      // Let a text editor or an open player menu handle Escape first.
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
      const player = playerRef.current;
      event.preventDefault();
      event.stopPropagation();
      const playbackInfo = pageRef.current?.querySelector<HTMLDetailsElement>('.playback-info[open]');
      if (playbackInfo) {
        event.preventDefault(); event.stopPropagation(); playbackInfo.open = false; return;
      }
      if (pageRef.current?.querySelector(".menu-open")) {
        danmuKeywordBlockPluginRef.current?.closePanel?.();
        danmuSettingsPluginRef.current?.closePanel?.();
        qualityPluginRef.current?.hideDropdown?.();
        linePluginRef.current?.hideDropdown?.();
        return;
      }
      if (player?.fullscreen || player?.cssfullscreen || document.fullscreenElement) {
        if (player?.fullscreen) void Promise.resolve(player.exitFullscreen()).catch(() => {});
        if (player?.cssfullscreen) player.exitCssFullscreen();
        if (!player?.fullscreen && !player?.cssfullscreen && document.fullscreenElement) void document.exitFullscreen().catch(() => {});
        return;
      }
      void (async () => {
        if ("__TAURI_INTERNALS__" in window) {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          if (await win.isFullscreen()) { await win.setFullscreen(false); return; }
        }
        if (disposedRef.current) return;
        await requestCloseRef.current();
      })().catch(console.error);
    };
    // Capture before xgplayer changes its fullscreen flags during the same event.
    window.addEventListener("keydown", onEscape, true);
    return () => window.removeEventListener("keydown", onEscape, true);
  }, [onRequestClose, router]);

  const chromeHiddenClass = chromeVisible ? "" : " player-chrome-hidden";

  const reloadStreamRef = useRef<
    | null
    | ((
        trigger: ReloadTrigger,
        overrides?: ReloadOverrides
      ) => Promise<void>)
  >(null);
  const qualityReloadArmedRef = useRef(false);
  const reloadInFlightRef = useRef(false);
  const pendingReloadRef = useRef<null | { trigger: ReloadTrigger; overrides?: ReloadOverrides }>(
    null
  );

  const isSessionActive = useCallback((sessionId: number) => {
    return !disposedRef.current && activeSessionIdRef.current === sessionId;
  }, []);

  useEffect(() => {
    if (platform === Platform.BILIBILI || platform === Platform.HUYA) {
      void ensureProxyStarted();
    }
  }, [ensureProxyStarted, platform]);

  useEffect(() => {
    setIsland({
      platform,
      roomId,
      anchorName: playerAnchorName,
      title: playerTitle,
      avatarUrl: getAvatarSrc(platform, playerAvatar)
    });
    return () => clearIsland();
  }, [clearIsland, getAvatarSrc, platform, playerAvatar, playerAnchorName, playerTitle, roomId, setIsland]);

  useEffect(() => {
    setFullscreen(isFullScreen);
    return () => setFullscreen(false);
  }, [isFullScreen, setFullscreen]);

  const isFollowed = useMemo(() => {
    const fp: FollowPlatform =
      platform === Platform.DOUYU
        ? "DOUYU"
        : platform === Platform.DOUYIN
          ? "DOUYIN"
          : platform === Platform.HUYA
            ? "HUYA"
            : "BILIBILI";
    return follow.isFollowed(fp, roomId);
  }, [follow, platform, roomId]);

  const destroyPlayer = useCallback(() => {
    watchCleanupRef.current?.();
    watchCleanupRef.current = null;
    danmakuTargetRef.current = null;
    try {
      unlistenRef.current?.();
    } catch {
      // ignore
    }
    unlistenRef.current = null;

    try {
      danmuOverlayRef.current?.destroy?.();
    } catch {
      // ignore
    }
    danmuOverlayRef.current = null;

    try {
      playerRef.current?.destroy();
    } catch {
      // ignore
    }
    playerRef.current = null;
    playbackKindRef.current = null;

    refreshPluginRef.current = null;
    volumePluginRef.current = null;
    danmuTogglePluginRef.current = null;
    danmuSettingsPluginRef.current = null;
    qualityPluginRef.current = null;
    linePluginRef.current = null;

    setIsFullScreen(false);
  }, []);

  const stopAllDanmakuBackends = useCallback(async () => {
    // Business rule: only one room at a time. Stopping all backends is the safest way to avoid cross-platform leaks.
    try {
      await invoke("stop_danmaku_listener", { roomId: "" });
    } catch {
      // ignore
    }
    try {
      await invoke("stop_douyin_danmu_listener");
    } catch {
      // ignore
    }
    try {
      await invoke("stop_huya_danmaku_listener", { roomId: "" });
    } catch {
      // ignore
    }
    try {
      await invoke("stop_bilibili_danmaku_listener");
    } catch {
      // ignore
    }
  }, []);

  const stopAllProxies = useCallback(async () => {
    // Only one room at a time; stop both to avoid "switch platform" leaks.
    try {
      await stopDouyuProxy();
    } catch {
      // ignore
    }
    try {
      await stopHuyaProxy();
    } catch {
      // ignore
    }
    // Bilibili's legacy FLV fallback also owns this shared proxy, but does not
    // set either platform helper's flag.
    try { await invoke("stop_proxy"); } catch { /* already stopped */ }
    try { await invoke("stop_direct_media"); } catch { /* already stopped */ }
  }, []);

  const startDanmaku = useCallback(
    async (
      sessionId: number,
      overlay: DanmuOverlayInstance | null,
      platformToStart: Platform,
      roomIdToStart: string,
      roomIdToFilter?: string
    ) => {
      danmakuTargetRef.current = [sessionId, overlay, platformToStart, roomIdToStart, roomIdToFilter];
      try {
        unlistenRef.current?.();
      } catch {
        // ignore
      }
      unlistenRef.current = null;

       if (!roomIdToStart) return;
       if (!isSessionActive(sessionId)) return;

       try {
         try {
           overlay?.clear?.();
         } catch {
           // ignore
         }
         // Always stop existing backends first (cross-platform), then start the current one.
         await stopAllDanmakuBackends();
         if (!isSessionActive(sessionId) || !receiveDanmuRef.current) return;

         if (platformToStart === Platform.DOUYU) {
           await invoke("start_danmaku_listener", { roomId: roomIdToStart });
         } else if (platformToStart === Platform.DOUYIN) {
           const payload: RustGetStreamUrlPayload = { args: { room_id_str: roomIdToStart }, platform: Platform.DOUYIN };
           await invoke("start_douyin_danmu_listener", { payload });
         } else if (platformToStart === Platform.HUYA) {
           await invoke("start_huya_danmaku_listener", { payload: { args: { room_id_str: roomIdToStart } } });
         } else if (platformToStart === Platform.BILIBILI) {
           const cookie = typeof localStorage !== "undefined" ? localStorage.getItem("bilibili_cookie") : null;
           await invoke("start_bilibili_danmaku_listener", {
             payload: { args: { room_id_str: roomIdToStart } },
             cookie: cookie || null
           });
         }
       } catch (e) {
         console.warn("[Player] start danmaku backend failed:", e);
         return;
       }

       const effectiveFilterRoomId = roomIdToFilter || roomIdToStart;
       if (!isSessionActive(sessionId)) return;
       const unlisten = await listen<UnifiedRustDanmakuPayload>("danmaku-message", (event: TauriEvent<UnifiedRustDanmakuPayload>) => {
         if (!isSessionActive(sessionId) || !receiveDanmuRef.current) return;
         const p = event.payload;
         if (!p) return;
        if (p.room_id && p.room_id !== effectiveFilterRoomId) return;

         const msg: DanmakuMessage = {
           id: uuidv4(),
           nickname: p.user || "未知用户",
           content: p.content || "",
           level: String(p.user_level || 0),
           badgeLevel: p.fans_club_level > 0 ? String(p.fans_club_level) : undefined,
           room_id: p.room_id || effectiveFilterRoomId
         };

        const contentLower = (msg.content || "").toLowerCase();
        const block = danmuKeywordBlockRef.current;
        if (block.keywordsLower.length > 0) {
          for (const kw of block.keywordsLower) {
            if (kw && contentLower.includes(kw)) {
              return;
            }
          }
        }

        if (overlay?.sendComment) {
          try {
            overlay.sendComment({
              id: msg.id,
              txt: msg.content,
              mode: "scroll",
              style: {
                color: msg.color || "#FFFFFF"
              }
            });
          } catch {
            // ignore
          }
        }
      });

      if (isSessionActive(sessionId)) unlistenRef.current = unlisten;
      else unlisten();
    },
    [isSessionActive, stopAllDanmakuBackends]
  );

  useEffect(() => {
    // Serialize with room/quality changes, so an old stop cannot tear down the
    // next room. Disabled/hidden chat does no websocket parsing or UI event work.
    void enqueuePlayback(async () => {
      const target = danmakuTargetRef.current;
      if (!target || !isSessionActive(target[0])) return;
      await startDanmaku(...target);
    }).catch(console.error);
  }, [isDanmuEnabled, pageVisible, isSessionActive, startDanmaku]);

  const attachPlaybackWatch = useCallback((sessionId: number, player: any) => {
    watchCleanupRef.current?.();
    statsRef.current = { ...EMPTY_PLAYBACK_STATS };
    watchCleanupRef.current = watchPlayback(player, {
      active: () => isSessionActive(sessionId) && playerRef.current === player,
      initial: sourceInfoRef.current,
      measureFrames: () => playbackInfoOpenRef.current && !pageRef.current?.classList.contains("player-chrome-hidden"),
      stats: value => {
        const changed = value.height !== statsRef.current.height || value.width !== statsRef.current.width;
        statsRef.current = value;
        if (changed) qualityPluginRef.current?.updateLabel?.(currentQualityRef.current);
      },
      progress: () => recoveryRef.current?.progress(),
      pause: () => recoveryRef.current?.reset(),
      failure: codecFailure => {
        if (codecFailure) forceAvcRef.current = true;
        if (playbackKindRef.current === 'native-hls') forceMseRef.current = true;
        recoveryRef.current?.fail();
      },
    });
  }, [isSessionActive]);

  const mountPlayer = useCallback(
    async (
      sessionId: number,
      url: string,
      streamType: string | undefined,
      danmakuBackendRoomIdOverride?: string | null,
      danmakuFilterRoomIdOverride?: string | null
    ) => {
      if (!isSessionActive(sessionId)) return;
      // 等待 DOM 渲染完成，确保 ref 可用
      let attempts = 0;
      while (!playerContainerRef.current && attempts < 10) {
        await new Promise(resolve => setTimeout(resolve, 50));
        attempts++;
      }
      
      if (!playerContainerRef.current) {
        console.error("[Player] Player container ref is not available after waiting");
        throw new Error("播放器容器初始化失败，请刷新页面重试。");
      }
      if (!isSessionActive(sessionId)) return;

      const isHlsPlayback = (streamType || "").toLowerCase() === "hls" || url.toLowerCase().includes(".m3u8");

      const nativeHls = isHlsPlayback && !forceMseRef.current && /Mac/i.test(navigator.platform)
        && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl');
      const [{ default: PlayerCtor }, flvMod, hlsMod, overlayMod, pluginsMod] = await Promise.all([
        import("xgplayer"),
        isHlsPlayback ? Promise.resolve(null) : import("xgplayer-flv"),
        isHlsPlayback && !nativeHls ? import("xgplayer-hls.js") : Promise.resolve(null),
        import("@/components/player/danmuOverlay"),
        import("@/components/player/plugins")
      ]);
      if (!isSessionActive(sessionId)) return;

      const FlvPlugin: any = (flvMod as any)?.default ?? flvMod;
      const HlsPlugin: any = hlsMod ? withHlsTimerCleanup((hlsMod as any).default ?? hlsMod) : null;
      const { applyDanmuOverlayPreferences, createDanmuOverlay, syncDanmuEnabledState } = overlayMod as any;
      const { DanmuKeywordBlockControl, DanmuSettingsControl, DanmuToggleControl, LineControl, QualityControl, RefreshControl, VolumeControl } =
        pluginsMod as any;

      const playerOptions: any = {
        el: playerContainerRef.current,
        url,
        autoplay: true,
        isLive: true,
        playsinline: true,
        lang: "zh-cn",
        videoFillMode: "contain",
        closeVideoClick: true,
        closeVideoTouch: true,
        keyShortcut: true,
        width: "100%",
        height: "100%",
        volume: false as unknown as number,
        pip: {
          position: POSITIONS.CONTROLS_RIGHT,
          index: 3,
          showIcon: true
        },
        cssFullscreen: {
          index: 2
        },
        playbackRate: false,
        controls: {
          mode: "normal"
        },
        icons: {
          play: ICONS.play,
          pause: ICONS.pause,
          fullscreen: ICONS.maximize2,
          exitFullscreen: ICONS.minimize2,
          cssFullscreen: ICONS.fullscreen,
          exitCssFullscreen: ICONS.minimize2,
          pipIcon: ICONS.pictureInPicture2,
          pipIconExit: ICONS.pictureInPicture2
        }
      };

      if (nativeHls) {
        playerOptions.plugins = [];
      } else if (isHlsPlayback) {
        playerOptions.plugins = [HlsPlugin];
        // xgplayer-hls.js reads HlsJsPlugin.hlsOpts; the old `hls` key was ignored.
        playerOptions.hlsJsPlugin = { hlsOpts: { ...LIVE_HLS_OPTIONS } };
      } else {
        // 弱网/兼容性兜底：部分 WebView2 环境对 `hev1` codec 字符串不支持，但对 `hvc1` 支持。
        // xgplayer-transmuxer 默认会生成 `hev1.*`，这里在运行时探测后做一次 monkey patch。
        const hev1 = 'video/mp4; codecs="hev1.1.6.L93.B0"';
        const hvc1 = 'video/mp4; codecs="hvc1.1.6.L93.B0"';
        if (!hevcBrandPatchedRef.current && !supportsMseType(hev1) && supportsMseType(hvc1)) {
          try {
            const mod: any = await import("xgplayer-transmuxer/es/codec/hevc.js");
            const HEVC: any = mod?.HEVC;
            const orig = HEVC?.parseHEVCDecoderConfigurationRecord;
            if (HEVC && typeof orig === "function") {
              HEVC.parseHEVCDecoderConfigurationRecord = function (data: any, hvcC?: any) {
                const ret = orig.call(this, data, hvcC);
                if (ret && typeof ret.codec === "string" && ret.codec.startsWith("hev1")) {
                  ret.codec = `hvc1${ret.codec.slice(4)}`;
                }
                return ret;
              };
              hevcBrandPatchedRef.current = true;
              console.info("[Player] Patched HEVC codec brand: hev1 -> hvc1 (MSE compatibility).");
            }
          } catch (e) {
            console.warn("[Player] Failed to patch HEVC codec brand:", e);
          }
        }

        playerOptions.plugins = [FlvPlugin];
        playerOptions.flv = {
          isLive: true,
          // xgplayer-flv (not flv.js) already uses native MSE media decoding.
          // Keep the existing latency/buffer defaults and pause disconnection.
          softDecode: false,
          bufferBehind: 10,
          disconnectTime: 0,
        };
      }

      const player = new (PlayerCtor as any)(playerOptions);
      playerRef.current = player;
      if (!isSessionActive(sessionId)) {
        try {
          player.destroy?.();
        } catch {
          // ignore
        }
        playerRef.current = null;
        return;
      }
      playbackKindRef.current = nativeHls ? "native-hls" : isHlsPlayback ? "hls" : "flv";
      setPlaybackEngine(nativeHls ? "系统 HLS" : isHlsPlayback ? "兼容 HLS" : "系统解码 · FLV");
      attachPlaybackWatch(sessionId, player);

      try {
        const storedPlayerVolume = loadStoredVolume();
        if (storedPlayerVolume !== null) {
          player.volume = storedPlayerVolume;
          player.muted = storedPlayerVolume === 0 ? true : player.muted;
        }
      } catch {
        // ignore
      }

      try {
        const onFull = (value: boolean) => setIsFullScreen(!!value || !!player.cssfullscreen);
        const onCssFull = (value: boolean) => setIsFullScreen(!!value || !!player.fullscreen);
        player.on?.("fullscreen_change", onFull);
        player.on?.("cssFullscreen_change", onCssFull);
        player.on?.("destroy", () => setIsFullScreen(false));
      } catch {
        // ignore
      }

      refreshPluginRef.current = player.registerPlugin?.(RefreshControl, {
        position: POSITIONS.CONTROLS_LEFT,
        index: 2,
        onClick: () => void reloadStreamRef.current?.("refresh")
      });

      volumePluginRef.current = player.registerPlugin?.(VolumeControl, {
        position: POSITIONS.CONTROLS_LEFT,
        index: 3
      });

      danmuTogglePluginRef.current = player.registerPlugin?.(DanmuToggleControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 4,
        getState: () => danmuEnabledRef.current,
        onToggle: (enabled: boolean) => setIsDanmuEnabled(enabled)
      });

      danmuSettingsPluginRef.current = player.registerPlugin?.(DanmuSettingsControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 4.2,
        getSettings: () => danmuSettings,
        onChange: (partial: Partial<DanmuUserSettings>) => {
          setDanmuSettings((prev) => {
            const next: DanmuUserSettings = { ...prev, ...partial };
            next.area = sanitizeDanmuArea(next.area);
            next.opacity = sanitizeDanmuOpacity(next.opacity);
            if (typeof next.strokeColor !== "string") next.strokeColor = "#444444";
            return next;
          });
        }
      });

      danmuKeywordBlockPluginRef.current = player.registerPlugin?.(DanmuKeywordBlockControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 4.4,
        getPreferences: () => danmuKeywordBlockPrefsRef.current,
        onChange: (next: DanmuKeywordBlockPreferences) => setDanmuKeywordBlock({ enabled: true, keywords: next.keywords ?? [] })
      });

      qualityPluginRef.current = player.registerPlugin?.(QualityControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 5,
        options: [...qualityOptions],
        getCurrent: () => currentQualityRef.current,
        getDisplayLabel: () => statsRef.current.height ? `${statsRef.current.height}P` : actualQualityRef.current || currentQualityRef.current,
        onSelect: (value: string) => {
          if (value === currentQualityRef.current) return;
          setCurrentQuality(value);
          try {
            window.localStorage.setItem(`${platform}_preferred_quality`, value);
          } catch {
            // ignore
          }
        }
      });

      linePluginRef.current = player.registerPlugin?.(LineControl, {
        position: POSITIONS.CONTROLS_RIGHT,
        index: 5.2,
        options: [...lineOptions],
        getCurrentKey: () => resolveCurrentLineFor(lineOptionsRef.current, currentLineRef.current) ?? "",
        getCurrentLabel: () => {
          const key = resolveCurrentLineFor(lineOptionsRef.current, currentLineRef.current);
          return lineOptionsRef.current.find((o) => o.key === key)?.label ?? "线路";
        },
        onSelect: (lineKey: string) => {
          if (lineKey === currentLineRef.current) return;
          setCurrentLine(lineKey);
          persistLinePreference(platform, lineKey);
        }
      });

      arrangeControlClusters(player);

      // danmu overlay
      const overlay = createDanmuOverlay(player, danmuSettings, isDanmuEnabled) as DanmuOverlayInstance | null;
      danmuOverlayRef.current = overlay;
      try {
        applyDanmuOverlayPreferences?.(overlay, danmuSettings, isDanmuEnabled, player.root as any);
        syncDanmuEnabledState(overlay, danmuSettings, isDanmuEnabled, player.root as any);
      } catch {
        // ignore
      }

      const backendRoomId = danmakuBackendRoomIdOverride || roomId;
      const filterRoomId = danmakuFilterRoomIdOverride || backendRoomId;
      await startDanmaku(sessionId, overlay, platform, backendRoomId, filterRoomId);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentLine, currentQuality, danmuSettings, isDanmuEnabled, isSessionActive, lineOptions, platform, roomId, startDanmaku]
  );

  const reloadStream = useCallback(
    async (trigger: ReloadTrigger, overrides?: ReloadOverrides) => {
      if (disposedRef.current) return;
      if (trigger !== "recovery") { recoveryRef.current?.reset(); lastPlaybackErrorRef.current = null; }
      const sessionId = ++sessionSeqRef.current;
      activeSessionIdRef.current = sessionId;
      watchCleanupRef.current?.();
      watchCleanupRef.current = null;
      if (reloadInFlightRef.current) {
        pendingReloadRef.current = { trigger, overrides };
        return;
      }
      reloadInFlightRef.current = true;
      await enqueuePlayback(async () => {
        try {
          if (!isSessionActive(sessionId)) return;
          setIsLoadingStream(true);
          setQualityNotice(null);
          setStreamError(null);
          setIsOfflineError(false);
          statsRef.current = { ...EMPTY_PLAYBACK_STATS };
          if (trigger !== "recovery") {
            actualQualityRef.current = null;
            qualityPluginRef.current?.updateLabel?.(currentQualityRef.current);
          }
          const effectiveQuality = overrides?.quality ?? currentQualityRef.current;
          const effectiveLine = overrides?.line !== undefined ? overrides.line : currentLineRef.current;
          const route = Math.max(0, (overrides?.attempt || 0) - 1);
          const preferHevc = !forceAvcRef.current && (platform === Platform.DOUYU || platform === Platform.DOUYIN)
            && await supportsEfficientHevc();
          await stopAllDanmakuBackends();
          await stopAllProxies();
          if (!isSessionActive(sessionId)) return;
          try { await applyDanmuFontFamilyForOS(); } catch { /* use system font */ }
          let stream: {
            streamUrl: string | null; streamType?: string; actualQuality?: string; qualityLimited?: boolean;
            actualLine?: string; sourceFps?: number | null; sourceCodec?: string | null;
          };
          let backendRoomId = roomId;
          let filterRoomId = roomId;
          if (platform === Platform.DOUYU) {
            if (trigger !== "recovery") {
              try {
                const info = await invoke<any>("fetch_douyu_room_info", { roomId });
                if (!isSessionActive(sessionId)) return;
                setPlayerTitle(info?.room_name ?? null); setPlayerAnchorName(info?.nickname ?? null); setPlayerAvatar(info?.avatar_url ?? null);
              } catch { /* playback can proceed without the room card */ }
            }
            stream = await getDouyuStreamConfig(roomId, effectiveQuality, resolveCurrentLineFor(lineOptions, effectiveLine), route, preferHevc);
          } else if (platform === Platform.DOUYIN) {
            const resp = await fetchAndPrepareDouyinStreamConfig(roomId, effectiveQuality, route, preferHevc);
            if (!isSessionActive(sessionId)) return;
            setPlayerTitle(resp.title ?? null); setPlayerAnchorName(resp.anchorName ?? null); setPlayerAvatar(resp.avatar ?? null);
            if (!resp.streamUrl) throw new Error(resp.initialError || "获取抖音直播流失败");
            stream = resp;
            backendRoomId = resp.webRid || roomId;
            filterRoomId = resp.normalizedRoomId || roomId;
          } else if (platform === Platform.HUYA) {
            const resp = await getHuyaStreamConfig(roomId, effectiveQuality, resolveCurrentLineFor(lineOptions, effectiveLine), route);
            if (!isSessionActive(sessionId)) return;
            setPlayerTitle(resp.title ?? null); setPlayerAnchorName(resp.anchorName ?? null); setPlayerAvatar(resp.avatar ?? null);
            stream = resp;
          } else {
            const cookie = localStorage.getItem("bilibili_cookie") || undefined;
            if (trigger !== "recovery") {
              try {
                const info = await invoke<any>("fetch_bilibili_streamer_info", { payload: { platform, args: { room_id_str: roomId } }, cookie: cookie || null });
                if (!isSessionActive(sessionId)) return;
                setPlayerTitle(info?.title ?? null); setPlayerAnchorName(info?.anchor_name ?? null); setPlayerAvatar(info?.avatar ?? null);
              } catch { /* room card is optional */ }
            }
            stream = await getBilibiliStreamConfig(roomId, effectiveQuality, cookie, route);
          }
          if (!isSessionActive(sessionId)) return;
          if (!stream.streamUrl) throw new Error("平台没有返回播放地址");
          stream.streamUrl = await invoke<string>("prepare_direct_media_url", {
            url: stream.streamUrl, platform: platform.toLowerCase()
          });
          if (!isSessionActive(sessionId)) return;
          actualQualityRef.current = stream.actualQuality || null;
          sourceInfoRef.current = { sourceFps: stream.sourceFps, sourceCodec: stream.sourceCodec };
          setActualLine(stream.actualLine || (route ? `备用线路 ${route}` : "自动"));
          if (stream.qualityLimited) {
            setQualityNotice(`平台实际返回 ${stream.actualQuality || '较低画质'}，与所选画质不同。${platform === Platform.BILIBILI || platform === Platform.DOUYU ? '可在 QTV 内登录后重试。' : '可稍后刷新重试。'}`);
          } else if (trigger === 'recovery' && effectiveQuality === '原画' && stream.actualQuality && !/原画|原始|待确认/.test(stream.actualQuality)) {
            setQualityNotice(`当前平台画质：${stream.actualQuality}。可在播放信息中查看实际分辨率。`);
          }
          setPlayerIsLive(true);
          const hls = stream.streamType === 'hls' || stream.streamUrl.includes('.m3u8');
          const kind = hls ? (!forceMseRef.current && /Mac/i.test(navigator.platform) && !!document.createElement('video').canPlayType('application/vnd.apple.mpegurl') ? 'native-hls' : 'hls') : 'flv';
          const player = playerRef.current;
          if (trigger !== 'recovery' && player && playbackKindRef.current === kind && typeof player.switchURL === 'function') {
            try {
              await player.switchURL(stream.streamUrl, { seamless: false });
              if (!isSessionActive(sessionId)) return;
              attachPlaybackWatch(sessionId, player);
              await startDanmaku(sessionId, danmuOverlayRef.current, platform, backendRoomId, filterRoomId);
            } catch {
              if (!isSessionActive(sessionId)) return;
              destroyPlayer();
              await mountPlayer(sessionId, stream.streamUrl, stream.streamType, backendRoomId, filterRoomId);
            }
          } else {
            destroyPlayer();
            await mountPlayer(sessionId, stream.streamUrl, stream.streamType, backendRoomId, filterRoomId);
          }
          if (isSessionActive(sessionId)) qualityPluginRef.current?.updateLabel?.(effectiveQuality);
        } catch (e: any) {
          if (!isSessionActive(sessionId)) return;
          destroyPlayer();
          const msg = String(e?.message || e);
          lastPlaybackErrorRef.current = msg;
          const offline = isConfirmedOfflineError(msg);
          setIsOfflineError(offline);
          setPlayerIsLive(offline ? false : null);
          if (offline) {
            recoveryRef.current?.reset();
            setStreamError(msg);
          } else {
            // The same bounded recovery budget applies to initial load failures.
            recoveryRef.current?.fail();
          }
        } finally {
          if (isSessionActive(sessionId)) setIsLoadingStream(false);
          reloadInFlightRef.current = false;
          const pending = pendingReloadRef.current;
          pendingReloadRef.current = null;
          if (pending && !disposedRef.current) void reloadStreamRef.current?.(pending.trigger, pending.overrides);
        }
      });
    },
    [attachPlaybackWatch, destroyPlayer, isSessionActive, lineOptions, mountPlayer, platform, roomId, startDanmaku, stopAllDanmakuBackends, stopAllProxies]
  );

  useEffect(() => {
    reloadStreamRef.current = reloadStream;
  }, [reloadStream]);

  useEffect(() => {
    forceAvcRef.current = false;
    forceMseRef.current = false;
    const recovery = createPlaybackRecovery({
      online: () => navigator.onLine !== false,
      retry: async attempt => { await reloadStreamRef.current?.('recovery', { attempt }); },
      onState: state => {
        setRecoveryState(state);
        if (state?.phase === 'failed') {
          destroyPlayer();
          setStreamError(lastPlaybackErrorRef.current ? `自动重连未能恢复播放：${lastPlaybackErrorRef.current}` : '自动重连未能恢复播放，请稍后再试。');
          const failedSession = activeSessionIdRef.current;
          void enqueuePlayback(async () => {
            if (!isSessionActive(failedSession)) return;
            await stopAllDanmakuBackends();
            await stopAllProxies();
          });
        }
      },
    });
    recoveryRef.current = recovery;
    const onNetwork = () => {
      const video = playerRef.current?.video;
      if (video?.paused && video.readyState >= 2 && !video.error && !video.ended) return;
      recovery.networkChanged();
    };
    window.addEventListener('online', onNetwork);
    window.addEventListener('offline', onNetwork);
    return () => {
      recovery.stop();
      window.removeEventListener('online', onNetwork);
      window.removeEventListener('offline', onNetwork);
      if (recoveryRef.current === recovery) recoveryRef.current = null;
    };
  }, [destroyPlayer, isSessionActive, platform, roomId, stopAllDanmakuBackends, stopAllProxies]);

  useEffect(() => {
    // Create a per-mount generation id to guard delayed stop against StrictMode(dev) remounts.
    (globalThis as any).__QTV_PLAYER_MOUNT_GEN = ((globalThis as any).__QTV_PLAYER_MOUNT_GEN ?? 0) + 1;
    mountGenRef.current = (globalThis as any).__QTV_PLAYER_MOUNT_GEN;
    return () => {
      disposedRef.current = true;
      recoveryRef.current?.stop();
      pendingReloadRef.current = null;
      activeSessionIdRef.current = ++sessionSeqRef.current;
      destroyPlayer();

      const capturedGen = mountGenRef.current;
      const stopAll = () => {
        void enqueuePlayback(async () => {
          const currentGen = (globalThis as any).__QTV_PLAYER_MOUNT_GEN ?? 0;
          if (currentGen !== capturedGen) return;
          await stopAllDanmakuBackends();
          await stopAllProxies();
        }).catch(console.error);
      };
      if (process.env.NODE_ENV === "development") {
        window.setTimeout(stopAll, 200);
      } else {
        stopAll();
      }
    };
  }, [destroyPlayer, stopAllDanmakuBackends, stopAllProxies]);

  useEffect(() => {
    disposedRef.current = false;
    setPlayerTitle(null);
    setPlayerAnchorName(null);
    setPlayerAvatar(null);
    setPlayerIsLive(null);
    destroyPlayer();
    void reloadStream("refresh");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [platform, roomId]);

  useEffect(() => {
    // Keep danmu overlay + controls in sync
    import("@/components/player/danmuOverlay")
      .then((mod: any) => {
        mod.applyDanmuOverlayPreferences?.(danmuOverlayRef.current, danmuSettings, isDanmuEnabled, playerRef.current?.root as any);
        mod.syncDanmuEnabledState?.(danmuOverlayRef.current, danmuSettings, isDanmuEnabled, playerRef.current?.root as any);
      })
      .catch(() => {});

    try {
      persistDanmuPreferences({ enabled: isDanmuEnabled, settings: danmuSettings });
    } catch {
      // ignore
    }

    try {
      danmuTogglePluginRef.current?.setState?.(isDanmuEnabled);
      danmuSettingsPluginRef.current?.setSettings?.(danmuSettings);
    } catch {
      // ignore
    }
  }, [danmuSettings, isDanmuEnabled]);

  useEffect(() => {
    try {
      persistDanmuKeywordBlockPreferences(danmuKeywordBlock);
    } catch {
      // ignore
    }

    try {
      danmuKeywordBlockPluginRef.current?.setPreferences?.(danmuKeywordBlock);
    } catch {
      // ignore
    }
  }, [danmuKeywordBlock]);

  useEffect(() => {
    try {
      qualityPluginRef.current?.setOptions?.([...qualityOptions]);
      qualityPluginRef.current?.updateLabel?.(currentQuality);
      linePluginRef.current?.setOptions?.([...lineOptions]);
      linePluginRef.current?.updateLabel?.(lineOptions.find((o) => o.key === resolveCurrentLineFor(lineOptions, currentLine))?.label ?? "线路");
    } catch {
      // ignore
    }
  }, [currentLine, currentQuality, lineOptions]);

  useEffect(() => {
    // quality / line change triggers reload (debounced a bit)
    if (!qualityReloadArmedRef.current) {
      qualityReloadArmedRef.current = true;
      return;
    }
    const id = window.setTimeout(() => void reloadStream("quality"), 80);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQuality, currentLine]);

  const followPayload = useMemo<FollowedStreamer>(() => {
    const fp: FollowPlatform =
      platform === Platform.DOUYU
        ? "DOUYU"
        : platform === Platform.DOUYIN
          ? "DOUYIN"
          : platform === Platform.HUYA
            ? "HUYA"
            : "BILIBILI";

    return {
      id: roomId,
      platform: fp,
      nickname: playerAnchorName || roomId,
      avatarUrl: playerAvatar || "",
      roomTitle: playerTitle || "",
      currentRoomId: roomId,
      liveStatus: "UNKNOWN"
    };
  }, [platform, playerAnchorName, playerAvatar, playerTitle, roomId]);

  return (
    <div
      className={`player-page${chromeHiddenClass}${floating.compact ? " player-compact" : ""}`}
      ref={pageRef}
      onPointerDownCapture={onPlayerPointerDownCapture}
    >
      {isWindows ? (
        <div className="player-window-controls" data-tauri-drag-region="false" aria-label="窗口控制">
          <button type="button" className="window-btn" data-tauri-drag-region="false" aria-label="最小化" onClick={() => void minimizeWindow()}>
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M6 12h12" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
          <button
            type="button"
            className="window-btn"
            data-tauri-drag-region="false"
            aria-label={isMaximized ? "还原" : "最大化"}
            onClick={() => void toggleMaximizeWindow()}
          >
            {!isMaximized ? (
              <svg viewBox="0 0 24 24" fill="none">
                <rect x="6.5" y="6.5" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none">
                <path d="M9 7.5h8a2 2 0 0 1 2 2v8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                <rect x="5.5" y="9.5" width="11" height="11" rx="1.6" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            )}
          </button>
          <button
            type="button"
            className="window-btn window-btn--close"
            data-tauri-drag-region="false"
            aria-label="关闭软件"
            onClick={() => void closeWindow()}
          >
            <svg viewBox="0 0 24 24" fill="none">
              <path d="M7 7l10 10" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              <path d="M17 7L7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ) : null}

      <div className="player-layout">
        <div className="main-content">
          <div className="player-container player-container--solo">
            <div className="video-container">
              <div className="player-topbar">
                <div className="floating-actions" data-tauri-drag-region="false">
                  <button type="button" disabled={!previousFollow || isSwitchingRoom || floating.busy} title="上一个关注的直播间" aria-label="上一个关注的直播间" onClick={() => switchFollowRoom(-1)}>
                    <ChevronUp size={18} />
                  </button>
                  <button type="button" disabled={!nextFollow || isSwitchingRoom || floating.busy} title="下一个关注的直播间" aria-label="下一个关注的直播间" onClick={() => switchFollowRoom(1)}>
                    <ChevronDown size={18} />
                  </button>
                  {floating.compact ? <button type="button" disabled={!floating.ready || floating.busy} aria-pressed={floating.pinned} title={floating.pinned ? "取消置顶" : "锁定置顶"} aria-label={floating.pinned ? "取消置顶" : "锁定置顶"} onClick={() => void floating.togglePin()}>
                    {floating.pinned ? <PinOff size={18} /> : <Pin size={18} />}
                  </button> : null}
                  <button type="button" disabled={!floating.ready || floating.busy || isFullScreen} title={floating.compact ? "恢复窗口大小" : "缩为小窗"} aria-label={floating.compact ? "恢复窗口大小" : "缩为小窗"} onClick={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    void floating.toggleCompact({ x: e.detail ? e.clientX : rect.left + rect.width / 2, y: e.detail ? e.clientY : rect.top + rect.height / 2 });
                  }}>
                    {floating.compact ? <Maximize2 size={18} /> : <Minimize2 size={18} />}
                  </button>
                  {floating.error ? <span role="status">{floating.error}</span> : null}
                </div>
                <div className="player-topbar-center">
                  <button
                    type="button"
                    className="player-close-btn"
                    title="关闭"
                    aria-label="关闭"
                    disabled={floating.busy}
                    onClick={() => void requestClose()}
                  >
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="22"
                      height="22"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="18" y1="6" x2="6" y2="18" />
                      <line x1="6" y1="6" x2="18" y2="18" />
                    </svg>
                  </button>

                  <div className="player-topbar-streamer" title={playerTitle || roomId}>
                    <div className="player-topbar-avatar">
                      {playerAvatar ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={getAvatarSrc(platform, playerAvatar)} alt={playerAnchorName ?? roomId} />
                      ) : (
                        <div className="player-topbar-avatarFallback">{(playerAnchorName || roomId || "Q").charAt(0).toUpperCase()}</div>
                      )}
                    </div>
                    <div className="player-topbar-meta">
                      <div className="player-topbar-title">{playerTitle || roomId}</div>
                      <div className="player-topbar-sub">
                        {playerAnchorName || "未知主播"} · ID:{roomId}
                      </div>
                    </div>
                    <div className={`player-topbar-status ${playerIsLive === true ? "is-live" : "is-offline"}`}>
                      {isLoadingStream ? "加载中" : playerIsLive === false ? "未开播" : playerIsLive === true ? "直播中" : "状态未知"}
                    </div>
                    <button
                      type="button"
                      className={`player-topbar-follow ${isFollowed ? "is-following" : ""}`}
                      onClick={() => {
                        if (isFollowed) follow.unfollowStreamer(followPayload.platform, followPayload.id);
                        else follow.followStreamer(followPayload);
                      }}
                    >
                      {isFollowed ? "取关" : "关注"}
                    </button>
                    {platform === Platform.DOUYU ? <DouyuLoginControls onChanged={() => void reloadStream("refresh")} /> : null}
                  </div>
                </div>
              </div>

              {qualityNotice ? <div className="bilibili-quality-notice" role="status">
                <span>{qualityNotice}</span>
                {platform === Platform.BILIBILI ? <BilibiliCookieControls autoBootstrap={false} onCookieChanged={() => void reloadStream("refresh")} /> : null}
              </div> : null}

              <PlaybackInfo onOpenChange={open => { playbackInfoOpenRef.current = open; }} statsRef={statsRef} quality={actualQualityRef.current} line={actualLine} engine={playbackEngine} />
              {recoveryState && recoveryState.phase !== 'failed' ? <div className="playback-recovery" role="status">
                {recoveryState.phase === 'waiting' ? '网络已断开，联网后自动继续' : `正在恢复播放 · ${recoveryState.attempt}/${recoveryState.max}`}
              </div> : null}
              <div ref={playerContainerRef} className="video-player" />

              {isLoadingStream ? (
                <div className="loading-player" style={{ position: "absolute", inset: 0, zIndex: 20 }}>
                </div>
              ) : null}

              {streamError ? (
                <div className={isOfflineError ? "offline-player" : "error-player"} style={{ position: "absolute", inset: 0, zIndex: 20 }}>
                  <div style={{ padding: 18, width: "min(520px, 92vw)", margin: "0 auto", textAlign: "left" }}>
                    <div style={{ fontSize: 14, fontWeight: 800, marginBottom: 10 }}>{isOfflineError ? "主播未开播" : "加载失败"}</div>
                    <div style={{ color: "var(--secondary-text)", fontWeight: 600, whiteSpace: "pre-wrap" }}>{streamError}</div>
                    <div style={{ display: "flex", gap: 10, marginTop: 14, justifyContent: "flex-start" }}>
                      <button className="retry-btn" onClick={() => void reloadStream("refresh")}>
                        再试一次
                      </button>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
