import type { MatchFrame, PlayerFrame } from "./types";

function lerp(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

/** Turn from one angle to another the short way round. */
function lerpAngle(from: number, to: number, t: number): number {
  let diff = (to - from) % (Math.PI * 2);
  if (diff > Math.PI) diff -= Math.PI * 2;
  else if (diff < -Math.PI) diff += Math.PI * 2;
  return from + diff * t;
}

/**
 * The pitch at any point through a minute. The engine sends snapshots a few
 * times a second; the screen redraws far more often, so glide between the two
 * snapshots either side of `progress` (0 = start of the minute, 1 = the end).
 * What a player is doing (the animation) is taken from the earlier snapshot.
 */
export function interpolateFrame(frames: MatchFrame[], progress: number): MatchFrame | null {
  if (frames.length === 0) return null;
  const clamped = Math.min(1, Math.max(0, progress));
  const position = clamped * (frames.length - 1);
  const index = Math.floor(position);
  const from = frames[index];
  const to = frames[Math.min(index + 1, frames.length - 1)];
  const t = position - index;
  if (t === 0 || from === to) return from;

  const players: PlayerFrame[] = from.players.map((before, i) => {
    const after = to.players[i] ?? before;
    return {
      x: lerp(before.x, after.x, t),
      y: lerp(before.y, after.y, t),
      z: lerp(before.z, after.z, t),
      facing: lerpAngle(before.facing, after.facing, t),
      anim: before.anim,
    };
  });

  return {
    tick: from.tick,
    ball: {
      x: lerp(from.ball.x, to.ball.x, t),
      y: lerp(from.ball.y, to.ball.y, t),
      z: lerp(from.ball.z, to.ball.z, t),
    },
    players,
  };
}

/** Animations that are a one-off action rather than standing or running. */
export function isActionAnim(anim: PlayerFrame["anim"]): boolean {
  return anim !== "Idle" && anim !== "Walk" && anim !== "Sprint";
}
