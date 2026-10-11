"use client";

import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Settings, X } from "lucide-react";
import styles from "./NetworkSettings.module.css";

export function NetworkSettings({ buttonClassName }: { buttonClassName: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const [direct, setDirect] = useState(true);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    let cancelled = false;
    setLoaded(false);
    setStatus("");
    invoke<{ directPlayback: boolean }>("get_network_settings")
      .then(result => { if (!cancelled) { setDirect(result.directPlayback); setLoaded(true); } })
      .catch(() => { if (!cancelled) setStatus("读取网络设置失败，请关闭后重试。"); });
    return () => { cancelled = true; };
  }, [open]);

  const save = async () => {
    if (busy || !loaded) return;
    setBusy(true);
    try {
      const result = await invoke<{ directPlayback: boolean }>("set_network_settings", { directPlayback: !direct });
      setDirect(result.directPlayback);
      setStatus("已保存，下次打开直播时生效。");
    } catch {
      setStatus("保存失败，原设置已保留，请重试。");
    } finally { setBusy(false); }
  };

  return <>
    <button type="button" className={buttonClassName} aria-label="设置" title="设置" data-tauri-drag-region="false" onClick={() => setOpen(true)}>
      <Settings size={17} />
    </button>
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="network-settings-title"
      onClose={() => setOpen(false)} onClick={event => { if (event.target === dialog.current) dialog.current?.close(); }}>
      <div className={styles.heading}>
        <h2 id="network-settings-title">网络设置</h2>
        <button type="button" aria-label="关闭设置" onClick={() => dialog.current?.close()}><X size={18} /></button>
      </div>
      <div className={styles.row}>
        <div><strong id="direct-playback-label">直播直连，不使用系统代理</strong>
          <p id="direct-playback-description">开启后，直播视频使用本地网络直连。直播信息与弹幕默认直连。</p></div>
        <button type="button" role="switch" aria-checked={direct} aria-labelledby="direct-playback-label"
          aria-describedby="direct-playback-description" className={styles.switch} disabled={!loaded || busy} onClick={() => void save()}><span /></button>
      </div>
      <p className={styles.hint}>关闭后，视频播放恢复原有网络方式。设置自动保存，无需重启。</p>
      <p className={styles.hint}>如果代理软件开启了 TUN 或 VPN 全局接管，请在代理软件中将 QTV 或直播平台设为直连。</p>
      <p className={styles.status} role="status" aria-live="polite">{status || (!loaded ? "正在读取…" : "")}</p>
    </dialog>
  </>;
}
