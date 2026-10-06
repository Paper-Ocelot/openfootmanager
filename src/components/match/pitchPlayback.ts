import type { MatchEvent, MatchSnapshot } from "./types";

/** Goal events mark the kick; the reconstruction reaches the goal 0.8s later. */
export function eventPlaybackSecond(event: MatchEvent): number {
  const second = event.second ?? 59;
  return Math.min(
    59.9,
    second + (event.event_type === "Goal" || event.event_type === "PenaltyGoal" ? 0.8 : 0),
  );
}

/** Presentation only: never write this score back to the match. */
export function scoreAtCursor(snapshot: MatchSnapshot, minute: number, second: number) {
  let home = snapshot.home_score;
  let away = snapshot.away_score;
  for (const event of snapshot.events) {
    if (event.event_type !== "Goal" && event.event_type !== "PenaltyGoal") continue;
    if (event.minute > minute || (event.minute === minute && eventPlaybackSecond(event) > second)) {
      if (event.side === "Home") home--;
      else away--;
    }
  }
  return { home: Math.max(0, home), away: Math.max(0, away) };
}

export function eventAtCursor(events: MatchEvent[], minute: number, second: number) {
  const visible = events
    .filter((event) => event.minute === minute && eventPlaybackSecond(event) <= second)
    .sort((a, b) => eventPlaybackSecond(a) - eventPlaybackSecond(b));
  return visible[visible.length - 1];
}
