"use client";

import { parseDouyinRoomInput } from "@/services/douyinRoomInput";
import { DouyinRoomSuggestion } from "@/components/shell/DouyinRoomSuggestion";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, m } from "framer-motion";
import { useNavSlot } from "@/components/shell/navSlot";
import { ArrowDown, ArrowUp, Check, ChevronsUp, Eye, EyeOff, Heart, Play, RotateCw, Search, Settings2, Undo2, X } from "lucide-react";
import { useFollow, type FollowedStreamer } from "@/state/follow/FollowProvider";
import { usePlayerOverlay } from "@/state/playerOverlay/PlayerOverlayProvider";
import { useFollowRefresh } from "@/hooks/useFollowRefresh";
import { useImageProxy } from "@/hooks/useImageProxy";
import styles from "./FollowsHomePage.module.css";

const platformNames = { DOUYU: "斗鱼", HUYA: "虎牙", DOUYIN: "抖音", BILIBILI: "B站" };
const ease = [0.16, 1, 0.3, 1] as const;
const keyOf = (s: FollowedStreamer) => `${s.platform}:${s.id}`;

function Picture({ src, className, fallback, alt = "" }: { src: string; className: string; fallback: React.ReactNode; alt?: string }) {
  // Track by src so a cached image that loads before effects run is never hidden again.
  const [failedSrc, setFailedSrc] = useState("");
  const [loadedSrc, setLoadedSrc] = useState("");
  return src && failedSrc !== src
    ? <img className={`${className} ${styles.fadeImg} ${loadedSrc === src ? styles.fadeImgIn : ""}`} src={src} alt={alt} loading="lazy" decoding="async" onLoad={() => setLoadedSrc(src)} onError={() => setFailedSrc(src)} />
    : <div className={className}>{fallback}</div>;
}

function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), intervalMs); return () => window.clearInterval(id); }, [intervalMs]);
  return now;
}

function formatUpdated(at: number | null, now: number) {
  if (!at) return "每 3 分钟自动刷新";
  const diff = Math.max(0, Math.round((now - at) / 60000));
  return diff < 1 ? "刚刚更新" : `${diff} 分钟前更新`;
}

export function FollowsHomePage() {
  const follow = useFollow();
  const { openPlayer, isOpen } = usePlayerOverlay();
  const { refresh, refreshing, progress, lastRefreshAt } = useFollowRefresh(!isOpen);
  const { ensureProxyStarted, getAvatarSrc, proxify, proxyReady } = useImageProxy();
  const [query, setQuery] = useState("");
  const douyinRoomId = parseDouyinRoomInput(query, false);
  const [searchFocused, setSearchFocused] = useState(false);
  const enterDouyinRoom = () => { if (douyinRoomId) { setQuery(""); openPlayer({ platform: "douyin", roomId: douyinRoomId }); } };
  const [managing, setManaging] = useState(false);
  const [folder, setFolder] = useState("");
  const [removed, setRemoved] = useState<{ streamer: FollowedStreamer; folderIds: string[]; nextKey?: string } | null>(null);
  const [sortStatus, setSortStatus] = useState("");
  const searchRef = useRef<HTMLInputElement | null>(null);
  const navSlot = useNavSlot();
  const now = useNow(30000);

  useEffect(() => { void ensureProxyStarted(); }, [ensureProxyStarted]);

  // "/" focuses search, Escape clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (e.key === "/" && !typing && !isOpen) { e.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isOpen]);

  // Undo toast dismisses itself.
  useEffect(() => {
    if (!removed) return;
    const id = window.setTimeout(() => setRemoved(null), 6000);
    return () => window.clearTimeout(id);
  }, [removed]);

  const total = follow.followedStreamers.length;
  const failedCount = follow.followedStreamers.filter(s => !s.hidden && s.refreshError).length;
  const filtered = useMemo(() => {
    const keys = folder ? follow.folders.find(f => f.id === folder)?.streamerIds : null;
    const needle = (douyinRoomId || query).trim().toLowerCase();
    return follow.followedStreamers.filter(s => (!keys || keys.includes(keyOf(s))) &&
      `${s.nickname} ${s.id} ${platformNames[s.platform]} ${s.roomTitle || ""}`.toLowerCase().includes(needle));
  }, [folder, follow.followedStreamers, follow.folders, query, douyinRoomId]);
  const live = filtered.filter(s => !s.hidden && s.liveStatus === "LIVE");
  const others = filtered.filter(s => !s.hidden && s.liveStatus !== "LIVE");

  const remove = useCallback((s: FollowedStreamer) => {
    const index = follow.followedStreamers.findIndex(item => keyOf(item) === keyOf(s));
    const next = follow.followedStreamers[index + 1];
    setRemoved({ streamer: s, folderIds: follow.folders.filter(f => f.streamerIds.includes(keyOf(s))).map(f => f.id), nextKey: next ? keyOf(next) : undefined });
    follow.unfollowStreamer(s.platform, s.id);
  }, [follow]);
  const undo = () => {
    if (!removed) return;
    follow.followStreamer(removed.streamer);
    if (removed.nextKey) follow.moveFollowedStreamer(keyOf(removed.streamer), removed.nextKey);
    removed.folderIds.forEach(id => follow.addStreamerToFolder(id, removed.streamer.platform, removed.streamer.id));
    setRemoved(null);
  };
  const open = (s: FollowedStreamer) => openPlayer({ platform: s.platform.toLowerCase(), roomId: s.id });
  const move = (streamer: FollowedStreamer, target: FollowedStreamer) => {
    follow.moveFollowedStreamer(keyOf(streamer), keyOf(target));
    setSortStatus(`已调整 ${streamer.nickname || streamer.id} 的顺序，自动保存`);
  };

  const itemMotion = (i: number) => ({
    layout: "position" as const,
    initial: { opacity: 0, y: 12, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.42, ease, delay: Math.min(i, 12) * 0.03 } },
    exit: { opacity: 0, scale: 0.94, transition: { duration: 0.18 } },
    transition: { layout: { duration: 0.36, ease } }
  });

  const removeButton = (s: FollowedStreamer, className: string) => (
    <AnimatePresence>
      {managing ? (
        <m.button
          type="button"
          className={className}
          onClick={() => remove(s)}
          aria-label={`取消关注 ${s.nickname}`}
          title="取消关注"
          initial={{ opacity: 0, scale: 0.5 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.5 }}
          transition={{ type: "spring", stiffness: 520, damping: 30 }}
        >
          <X size={14} strokeWidth={2.6} />
        </m.button>
      ) : null}
    </AnimatePresence>
  );

  const liveCard = (s: FollowedStreamer, i: number) => {
    const cover = s.coverUrl && proxyReady ? `${proxify(s.coverUrl)}&fresh=${s.lastCheckedAt || 0}` : "";
    const avatar = getAvatarSrc(s.platform, s.avatarUrl);
    return (
      <m.article key={keyOf(s)} className={styles.liveCard} {...itemMotion(i)}>
        <button type="button" className={styles.liveOpen} onClick={() => open(s)} aria-label={`打开 ${s.nickname || s.id} 的直播间`}>
          <div className={styles.coverWrap}>
            <Picture
              src={cover}
              className={styles.cover}
              alt={`${s.nickname} 的直播封面`}
              fallback={<div className={styles.coverFallback}>
                {avatar ? <img src={avatar} alt="" className={styles.coverFallbackBg} /> : null}
                <Picture src={avatar} className={styles.coverFallbackAvatar} fallback={(s.nickname || "?").slice(0, 1)} />
              </div>}
            />
            <div className={styles.coverShade} />
            <span className={styles.liveBadge}><i />直播中</span>
            <span className={styles.platformChip}>{platformNames[s.platform]}</span>
            <span className={styles.playIcon}><span><Play size={22} fill="currentColor" /></span></span>
          </div>
          <div className={styles.liveMeta}>
            <Picture src={avatar} className={styles.liveAvatar} fallback={(s.nickname || "?").slice(0, 1)} />
            <div className={styles.liveText}>
              <strong title={s.roomTitle}>{s.roomTitle || "直播中"}</strong>
              <span>{s.nickname || s.id}</span>
            </div>
          </div>
        </button>
        {removeButton(s, styles.removeBtn)}
      </m.article>
    );
  };

  const offlineCard = (s: FollowedStreamer, i: number) => {
    const status = s.refreshError ? "获取失败" : s.liveStatus === "UNKNOWN" ? "确认中…" : "未开播";
    return (
      <m.article key={keyOf(s)} className={styles.offlineCard} {...itemMotion(i)}>
        <button type="button" className={styles.offlineOpen} onClick={() => open(s)} aria-label={`打开 ${s.nickname || s.id} 的直播间`}>
          <Picture src={getAvatarSrc(s.platform, s.avatarUrl)} className={styles.offlineAvatar} fallback={(s.nickname || "?").slice(0, 1)} />
          <div className={styles.offlineText}>
            <strong>{s.nickname || s.id}</strong>
            <span>
              {platformNames[s.platform]}
              <b>·</b>
              <span className={s.refreshError ? styles.statusError : s.liveStatus === "UNKNOWN" ? styles.statusPending : ""}>{status}</span>
            </span>
          </div>
        </button>
        {removeButton(s, `${styles.removeBtn} ${styles.removeBtnSmall}`)}
      </m.article>
    );
  };

  const showSkeleton = !follow.hydrated;
  const percent = progress.total ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <section className={styles.page}>
      {navSlot ? createPortal(
        <>
          <div className={styles.searchWrap}
            onFocus={() => setSearchFocused(true)}
            onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) setSearchFocused(false); }}
          ><label className={styles.search}>
            <Search size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={e => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") enterDouyinRoom(); if (e.key === "Escape") { setQuery(""); e.currentTarget.blur(); } }}
              placeholder="主播、房间号或抖音链接"
              aria-label="搜索我的关注"
            />
            {query ? <button type="button" className={styles.searchClear} onClick={() => setQuery("")} aria-label="清除搜索"><X size={12} /></button> : <kbd>/</kbd>}
          </label>
          {searchFocused && douyinRoomId ? <div className={styles.linkSuggestion}><DouyinRoomSuggestion roomId={douyinRoomId} onOpen={enterDouyinRoom} /></div> : null}</div>
          <button
            type="button"
            className={`${styles.toolBtn} ${managing ? styles.toolBtnOn : ""}`}
            aria-pressed={managing}
            onClick={() => setManaging(!managing)}
            disabled={!total}
            title={managing ? "完成管理" : "管理关注"}
            aria-label={managing ? "完成管理" : "管理关注"}
          >
            {managing ? <Check size={17} /> : <Settings2 size={17} />}
          </button>
          <button
            type="button"
            className={styles.toolBtn}
            onClick={() => void refresh()}
            disabled={refreshing || !follow.hydrated || !total}
            title={refreshing ? `正在刷新 ${progress.current}/${progress.total}` : `刷新开播状态 · ${formatUpdated(lastRefreshAt, now)}`}
            aria-label="刷新开播状态"
          >
            <RotateCw size={17} className={refreshing ? styles.spinning : ""} />
          </button>
        </>,
        navSlot
      ) : null}

      <div className={`${styles.progress} ${refreshing ? styles.progressOn : ""}`} aria-hidden="true">
        <span style={{ transform: `scaleX(${refreshing ? Math.max(percent, 4) / 100 : 1})` }} />
      </div>

      <div className={styles.body}>
        {follow.folders.length ? (
          <div className={styles.folderChips} role="tablist" aria-label="关注分组">
            <button type="button" role="tab" aria-selected={!folder} onClick={() => setFolder("")}>全部</button>
            {follow.folders.map(f => (
              <button key={f.id} type="button" role="tab" aria-selected={folder === f.id} onClick={() => setFolder(folder === f.id ? "" : f.id)}>
                {f.name}<em>{f.streamerIds.length}</em>
              </button>
            ))}
          </div>
        ) : null}
        <AnimatePresence initial={false}>
          {failedCount > 0 && !refreshing ? (
            <m.p className={styles.notice} initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }}>
              {failedCount} 位主播暂时无法获取状态，点击右上角刷新按钮重试。
            </m.p>
          ) : null}
        </AnimatePresence>

        {showSkeleton ? (
          <div className={styles.liveGrid}>
            {Array.from({ length: 4 }, (_, i) => <div key={i} className={styles.skeletonCard}><div /><span /><span /></div>)}
          </div>
        ) : !total ? (
          <div className={styles.emptyState}>
            <span className={styles.emptyIcon}><Heart size={26} /></span>
            <strong>还没有关注主播</strong>
            <p>切换到上方的平台，打开直播间后点击「关注」，主播就会出现在这里。</p>
          </div>
        ) : managing ? (
          <div className={styles.orderPanel}>
            <div className={styles.orderHeading}>
              <h2>管理关注</h2>
              <span>自动保存</span>
            </div>
            <p className={styles.orderHint}>越靠前，越优先显示。首页的直播中与未开播主播，分别按此顺序排列。点击眼睛可隐藏或显示，隐藏不会取消关注。</p>
            <div className={styles.sortStatus} role="status" aria-live="polite">{sortStatus}</div>
            <div className={styles.orderList}>
              {filtered.map((s, i) => (
                <div className={styles.orderRow} key={keyOf(s)}>
                  <span className={styles.orderNumber}>{follow.followedStreamers.findIndex(item => keyOf(item) === keyOf(s)) + 1}</span>
                  <Picture src={getAvatarSrc(s.platform, s.avatarUrl)} className={styles.orderAvatar} fallback={(s.nickname || "?").slice(0, 1)} />
                  <div className={styles.orderName}>
                    <strong>{s.nickname || s.id}</strong>
                    <span>{s.hidden ? "已隐藏 · " : ""}{platformNames[s.platform]} · {s.liveStatus === "LIVE" ? "直播中" : s.liveStatus === "OFFLINE" ? "未开播" : "状态未知"}</span>
                  </div>
                  <div className={styles.orderActions}>
                    <button type="button" aria-pressed={!s.hidden} title={s.hidden ? "在首页显示" : "从首页隐藏"} aria-label={`${s.hidden ? "显示" : "隐藏"} ${s.nickname || s.id}`} onClick={() => {
                      follow.updateStreamer(s.platform, s.id, { hidden: !s.hidden });
                      setSortStatus(`已${s.hidden ? "显示" : "隐藏"} ${s.nickname || s.id}，自动保存`);
                    }}>{s.hidden ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                    <button type="button" disabled={i === 0} onClick={() => move(s, filtered[0])} title="移到列表最前" aria-label={`将 ${s.nickname || s.id} 移到最前`}><ChevronsUp size={16} /></button>
                    <button type="button" disabled={i === 0} onClick={() => move(s, filtered[i - 1])} title="上移" aria-label={`上移 ${s.nickname || s.id}`}><ArrowUp size={16} /></button>
                    <button type="button" disabled={i === filtered.length - 1} onClick={() => move(s, filtered[i + 1])} title="下移" aria-label={`下移 ${s.nickname || s.id}`}><ArrowDown size={16} /></button>
                    <button type="button" className={styles.orderRemove} onClick={() => remove(s)} title="取消关注" aria-label={`取消关注 ${s.nickname || s.id}`}><X size={15} /></button>
                  </div>
                </div>
              ))}
              {!filtered.length ? <div className={styles.emptyInline}>没有匹配的主播</div> : null}
            </div>
          </div>
        ) : (
          <>
            <div className={styles.sectionHead}>
              <h2>正在直播</h2>
              <span>{live.length}</span>
            </div>
            {live.length ? (
              <div className={styles.liveGrid}>
                <AnimatePresence mode="popLayout">{live.map(liveCard)}</AnimatePresence>
              </div>
            ) : (
              <div className={styles.emptyInline}>
                {query ? "没有匹配的直播中主播" : refreshing ? "正在检查开播状态…" : follow.followedStreamers.every(s => s.hidden) ? "关注的主播均已隐藏，可在管理关注中恢复显示" : "当前显示的主播暂时都没有开播"}
              </div>
            )}

            <AnimatePresence initial={false}>
              {others.length ? (
                <m.div key="others" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}>
                  <div className={styles.sectionHead}>
                    <h2>未开播</h2>
                    <span>{others.length}</span>
                  </div>
                  <div className={styles.offlineGrid}>
                    <AnimatePresence mode="popLayout">{others.map(offlineCard)}</AnimatePresence>
                  </div>
                </m.div>
              ) : null}
            </AnimatePresence>
          </>
        )}
      </div>

      <AnimatePresence>
        {removed ? (
          <m.div
            className={styles.toast}
            role="status"
            initial={{ opacity: 0, y: 24, x: "-50%", scale: 0.96 }}
            animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
            exit={{ opacity: 0, y: 16, x: "-50%", scale: 0.98 }}
            transition={{ type: "spring", stiffness: 460, damping: 34 }}
          >
            <span>已取消关注 <strong>{removed.streamer.nickname}</strong></span>
            <button type="button" onClick={undo}><Undo2 size={14} />撤销</button>
            <button type="button" className={styles.toastClose} onClick={() => setRemoved(null)} aria-label="关闭提示"><X size={14} /></button>
          </m.div>
        ) : null}
      </AnimatePresence>
    </section>
  );
}
