import { describe, expect, it } from "vitest";
import { eventsForMode, minuteToWatch } from "./highlights";
import type { MatchEvent } from "./types";

const evt = (minute: number, event_type: string): MatchEvent => ({
  minute,
  event_type,
  side: "Home",
  zone: "Midfield",
  player_id: "p1",
  secondary_player_id: null,
});

const events = [
  evt(0, "KickOff"),
  evt(3, "PassCompleted"),
  evt(9, "ShotSaved"),
  evt(9, "Corner"),
  evt(14, "Tackle"),
  evt(21, "Goal"),
  evt(30, "Foul"),
  evt(30, "YellowCard"),
  evt(38, "Dribble"),
  evt(41, "Substitution"),
];

const types = (list: MatchEvent[]) => list.map((e) => e.event_type);

describe("eventsForMode", () => {
  it("keeps only the deciding moments in key highlights", () => {
    expect(types(eventsForMode(events, "key"))).toEqual([
      "KickOff",
      "Goal",
      "YellowCard",
      "Substitution",
    ]);
  });

  it("adds the chances, set pieces and fouls in extended highlights", () => {
    expect(types(eventsForMode(events, "extended"))).toEqual([
      "KickOff",
      "ShotSaved",
      "Corner",
      "Goal",
      "Foul",
      "YellowCard",
      "Substitution",
    ]);
  });

  it("shows everything in the full game", () => {
    expect(eventsForMode(events, "full")).toBe(events);
  });
});

describe("minuteToWatch", () => {
  it("follows the clock in the full game", () => {
    expect(minuteToWatch(events, "full", 17)).toBe(17);
  });

  it("stays on the latest key highlight until the next one", () => {
    expect(minuteToWatch(events, "key", 20)).toBeNull();
    expect(minuteToWatch(events, "key", 21)).toBe(21);
    expect(minuteToWatch(events, "key", 29)).toBe(21);
    expect(minuteToWatch(events, "key", 35)).toBe(30);
  });

  it("includes chances in extended highlights", () => {
    expect(minuteToWatch(events, "extended", 12)).toBe(9);
    expect(minuteToWatch(events, "extended", 25)).toBe(21);
  });

  it("does not treat kick-off or a substitution as something to watch", () => {
    expect(minuteToWatch(events, "key", 5)).toBeNull();
    expect(minuteToWatch(events, "key", 45)).toBe(30);
  });
});
