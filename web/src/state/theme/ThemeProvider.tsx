"use client";

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { flushSync } from "react-dom";

type ThemePreference = "light" | "dark" | "system";
type EffectiveTheme = "light" | "dark";

type ThemeContextValue = {
  userPreference: ThemePreference;
  effectiveTheme: EffectiveTheme;
  setUserPreference: (pref: ThemePreference) => void;
  toggleLightDark: () => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORE_KEY = "theme_preference";

async function setTauriWindowTheme(theme: EffectiveTheme) {
  try {
    const mod = await import("@tauri-apps/api/webviewWindow");
    const win = mod.WebviewWindow.getCurrent();
    await win.setTheme(theme);
  } catch {
    // 非 Tauri 环境无需处理
  }
}

function getSystemTheme(): EffectiveTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia?.("(prefers-color-scheme: dark)")?.matches ? "dark" : "light";
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [userPreference, setUserPreferenceState] = useState<ThemePreference>("system");
  const [systemTheme, setSystemTheme] = useState<EffectiveTheme>("light");
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") setUserPreferenceState(stored);
    } catch { /* Use the system theme if storage is unavailable. */ }
    setSystemTheme(getSystemTheme());
    setInitialized(true);

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return;

    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? "dark" : "light");
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);

  const effectiveTheme: EffectiveTheme = userPreference === "system" ? systemTheme : userPreference;

  useEffect(() => {
    if (!initialized) return;
    document.documentElement.setAttribute("data-theme", effectiveTheme);
    void setTauriWindowTheme(effectiveTheme);
  }, [effectiveTheme, initialized]);

  const value = useMemo<ThemeContextValue>(() => {
    return {
      userPreference,
      effectiveTheme,
      setUserPreference: (pref) => {
        setUserPreferenceState(pref);
        try {
          window.localStorage.setItem(STORE_KEY, pref);
        } catch {
          // ignore
        }
      },
      toggleLightDark: () => {
        const next = effectiveTheme === "light" ? "dark" : "light";
        try {
          window.localStorage.setItem(STORE_KEY, next);
        } catch {
          // ignore
        }
        // Per-element colour transitions flicker on nested/inherited text, so cross-fade
        // a snapshot of the whole page instead; fall back to an instant switch.
        const apply = () => {
          flushSync(() => setUserPreferenceState(next));
          document.documentElement.setAttribute("data-theme", next);
        };
        const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
        const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        if (doc.startViewTransition && !reduce) doc.startViewTransition(apply);
        else apply();
      }
    };
  }, [effectiveTheme, userPreference]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme() {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

