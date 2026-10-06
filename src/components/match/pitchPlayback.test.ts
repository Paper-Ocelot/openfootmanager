import { describe, expect, it } from "vitest";
import { eventAtCursor, scoreAtCursor } from "./pitchPlayback";
import type { MatchEvent, MatchSnapshot } from "./types";
const goal = (
  minute: number,
  second: number,
  side: "Home" | "Away",
  event_type = "Goal",
): MatchEvent => ({
  minute,
  second,
  side,
  event_type,
  zone: "AwayBox",
  player_id: "p1",
  secondary_player_id: null,
});
describe("viewer presentation timeline", () => {
  it("reveals a goal after the ball arrives, without mutating the real result", () => {
    const snapshot = {
      home_score: 2,
      away_score: 1,
      events: [goal(3, 10, "Home"), goal(12, 20, "Home"), goal(13, 10, "Away", "PenaltyGoal")],
    } as MatchSnapshot;
    expect(scoreAtCursor(snapshot, 12, 20)).toEqual({ home: 1, away: 0 });
    expect(scoreAtCursor(snapshot, 12, 21)).toEqual({ home: 2, away: 0 });
    expect(scoreAtCursor(snapshot, 13, 60)).toEqual({ home: 2, away: 1 });
    expect(snapshot.home_score).toBe(2);
    expect(snapshot.away_score).toBe(1);
  });
  it("does not announce future events or treat shootouts as normal goals", () => {
    const events = [goal(12, 20, "Home"), goal(12, 40, "Away", "ShotSaved")];
    expect(eventAtCursor(events, 12, 19)).toBeUndefined();
    expect(eventAtCursor(events, 12, 21)).toBe(events[0]);
    const snapshot = {
      home_score: 1,
      away_score: 1,
      events: [goal(120, 10, "Home", "ShootoutGoal")],
    } as MatchSnapshot;
    expect(scoreAtCursor(snapshot, 100, 0)).toEqual({ home: 1, away: 1 });
  });
});
