"use client";

import React, { useCallback, useContext, useMemo, useState } from "react";
import dynamic from "next/dynamic";

import styles from "./PlayerOverlayProvider.module.css";

const PlayerPage = dynamic(() => import("@/screens/PlayerPage").then((m) => m.PlayerPage), {
  ssr: false,
  loading: () => (
    <div style={{ padding: 18, color: "var(--secondary-text)", fontWeight: 700 }}>
      加载播放器...
    </div>
  )
});

type PlayerOverlayOpenPayload = { platform: string; roomId: string };

type PlayerOverlayContextValue = {
  isOpen: boolean;
  platform: string;
  roomId: string;
  openPlayer: (payload: PlayerOverlayOpenPayload) => void;
  closePlayer: () => void;
};

const PlayerOverlayContext = React.createContext<PlayerOverlayContextValue | null>(null);

export function usePlayerOverlay() {
  const ctx = useContext(PlayerOverlayContext);
  if (!ctx) throw new Error("usePlayerOverlay must be used within PlayerOverlayProvider");
  return ctx;
}

export function PlayerOverlayHost() {
  const { isOpen, platform, roomId, closePlayer } = usePlayerOverlay();

  // Unmount immediately: an exit animation used to delay native window restoration
  // and animate a decoding video while the home page was laid out at mini size.
  return (
    <>
      {isOpen ? (
        <div className={styles.overlayRoot}>
          <button type="button" className={styles.backdrop} aria-label="关闭播放器" onClick={closePlayer} />
          <div className={styles.overlayPanel}>
            <PlayerPage platform={platform} roomId={roomId} onRequestClose={closePlayer} />
          </div>
        </div>
      ) : null}
    </>
  );
}

export function PlayerOverlayProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<{ isOpen: boolean; platform: string; roomId: string }>({
    isOpen: false,
    platform: "douyu",
    roomId: ""
  });

  const openPlayer = useCallback((payload: PlayerOverlayOpenPayload) => {
    setState({ isOpen: true, platform: payload.platform, roomId: payload.roomId });
  }, []);

  const closePlayer = useCallback(() => {
    setState((s) => ({ ...s, isOpen: false }));
  }, []);

  const value = useMemo<PlayerOverlayContextValue>(
    () => ({
      isOpen: state.isOpen,
      platform: state.platform,
      roomId: state.roomId,
      openPlayer,
      closePlayer
    }),
    [closePlayer, openPlayer, state.isOpen, state.platform, state.roomId]
  );

  return <PlayerOverlayContext.Provider value={value}>{children}</PlayerOverlayContext.Provider>;
}
