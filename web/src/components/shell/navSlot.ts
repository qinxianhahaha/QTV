"use client";

import { useSyncExternalStore } from "react";

// A navbar slot that pages can portal their own toolbar controls into.
// Kept in a tiny external store so the target survives the navbar unmounting
// (e.g. fullscreen player) and remounting.
let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

export function setNavSlot(el: HTMLElement | null) {
  if (slot === el) return;
  slot = el;
  listeners.forEach(fn => fn());
}

export function useNavSlot() {
  return useSyncExternalStore(
    fn => { listeners.add(fn); return () => listeners.delete(fn); },
    () => slot,
    () => null
  );
}
