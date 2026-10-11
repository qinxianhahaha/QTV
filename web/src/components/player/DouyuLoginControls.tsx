"use client";

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { useEffect, useRef, useState } from 'react';

type Status = { loggedIn: boolean; windowOpen: boolean };

export function DouyuLoginControls({ onChanged }: { onChanged: () => void }) {
  const [loggedIn, setLoggedIn] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(false);
  const running = useRef(false);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;
  useEffect(() => {
    mounted.current = true;
    const subscriptions = [
      listen('douyu-login-completed', () => {
        if (!mounted.current) return;
        running.current = false;
        setBusy(false);
        setLoggedIn(true);
        setError('');
        onChangedRef.current();
      }),
      listen<string>('douyu-login-error', event => {
        if (!mounted.current) return;
        running.current = false;
        setBusy(false);
        setError(event.payload);
      }),
      listen('douyu-login-cancelled', () => {
        if (!mounted.current) return;
        running.current = false;
        setBusy(false);
      }),
    ];
    void invoke<Status>('get_douyu_login_status').then(s => {
      if (mounted.current) { setLoggedIn(s.loggedIn); setBusy(s.windowOpen); }
    }).catch(() => { if (mounted.current) setError('登录状态读取失败'); });
    return () => {
      mounted.current = false;
      subscriptions.forEach(subscription => { void subscription.then(unlisten => unlisten()); });
    };
  }, []);

  const changeLogin = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      if (loggedIn) {
        await invoke('clear_douyu_login');
        if (mounted.current) { setLoggedIn(false); onChangedRef.current(); }
      } else {
        // Recheck before opening: an existing session should go straight to playback.
        const status = await invoke<Status>('get_douyu_login_status');
        if (status.loggedIn) {
          if (mounted.current) { setLoggedIn(true); onChangedRef.current(); }
        } else {
          await invoke('open_douyu_login');
          return; // Backend completion closes the window and reloads the player.
        }
      }
    } catch {
      if (mounted.current) setError('斗鱼登录失败，请重试');
    }
    running.current = false;
    if (mounted.current) setBusy(false);
  };

  return <span className="cookie-status">
    <button type="button" className="cookie-status-btn" disabled={busy}
      title={error || (loggedIn ? '退出斗鱼登录' : '登录斗鱼后重新请求原画')}
      onClick={() => void changeLogin()}>
      {busy ? '登录中…' : loggedIn ? '退出登录' : '登录斗鱼'}
    </button>
    {error ? <span className="cookie-error" role="status">{error}</span> : null}
  </span>;
}
