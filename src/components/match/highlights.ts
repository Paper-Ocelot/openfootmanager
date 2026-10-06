import type { MatchEvent } from "./types";

/**
 * How much of a match to show, in the commentary and on the pitch view alike:
 * only the moments that decide it, those plus the chances, or everything.
 */
export type HighlightMode = "key" | "extended" | "full";

export const HIGHLIGHT_MODES: HighlightMode[] = ["key", "extended", "full"];

/** Goals, penalties, cards, injuries, changes and the whistles that frame the match. */
const KEY_EVENTS = new Set([
  "KickOff",
  "HalfTime",
  "SecondHalfStart",
  "FullTime",
  "Goal",
  "PenaltyAwarded",
  "PenaltyGoal",
  "PenaltyMiss",
  "ShootoutGoal",
  "ShootoutMiss",
  "YellowCard",
  "RedCard",
  "SecondYellow",
  "Injury",
  "Substitution",
]);

/** The chances and set pieces: what a longer highlights programme would add. */
const EXTENDED_EVENTS = new Set([
  ...KEY_EVENTS,
  "ShotOnTarget",
  "ShotSaved",
  "ShotOffTarget",
  "ShotBlocked",
  "Cross",
  "Corner",
  "FreeKick",
  "Foul",
]);

/**
 * Events with nothing to watch on the pitch. They belong in the commentary,
 * but a minute holding only these is not a highlight worth playing out.
 */
const NOTHING_TO_WATCH = new Set([
  "KickOff",
  "HalfTime",
  "SecondHalfStart",
  "FullTime",
  "Substitution",
]);

export function isShownInMode(evt: MatchEvent, mode: HighlightMode): boolean {
  if (mode === "full") return true;
  return (mode === "key" ? KEY_EVENTS : EXTENDED_EVENTS).has(evt.event_type);
}

/** The commentary for a mode: the events it shows, in match order. */
export function eventsForMode(events: MatchEvent[], mode: HighlightMode): MatchEvent[] {
  if (mode === "full") return events;
  return events.filter((evt) => isShownInMode(evt, mode));
}

/**
 * The minute the pitch view should play: in full-game mode the minute just
 * played; otherwise the most recent minute with a highlight to watch, or null
 * when the match has not produced one yet.
 */
export function minuteToWatch(
  events: MatchEvent[],
  mode: HighlightMode,
  currentMinute: number,
): number | null {
  if (mode === "full") return currentMinute;
  for (let i = events.length - 1; i >= 0; i--) {
    const evt = events[i];
    if (evt.minute > currentMinute) continue;
    if (NOTHING_TO_WATCH.has(evt.event_type)) continue;
    if (isShownInMode(evt, mode)) return evt.minute;
  }
  return null;
}
