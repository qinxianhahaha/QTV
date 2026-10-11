type FollowRoom = { platform: string; id: string; currentRoomId?: string; hidden?: boolean; liveStatus: string };

/** Follow the saved home-page order, wrapping and skipping unavailable rooms. */
export function adjacentFollowRoom<T extends FollowRoom>(follows: readonly T[], platform: string, roomId: string, direction: -1 | 1): T | null {
  const matchesCurrent = (room: T) => room.platform.toUpperCase() === platform.toUpperCase()
    && (room.id === roomId || room.currentRoomId === roomId);
  const current = follows.findIndex(matchesCurrent);
  for (let step = 1; step <= follows.length; step++) {
    const index = current < 0
      ? direction === 1 ? step - 1 : follows.length - step
      : (current + direction * step + follows.length) % follows.length;
    const room = follows[index];
    if (!matchesCurrent(room) && !room.hidden && room.liveStatus !== "OFFLINE") return room;
  }
  return null;
}
