import { afterAll, beforeAll, describe, expect, it } from "vitest";
import i18n, { i18nReady } from "../../i18n";
import { formatEventTime, getCommentary, getPitchArea, getPitchAreaLabel } from "./commentary";
import type { MatchEvent, MatchSnapshot, EnginePlayerData } from "./types";

const makePlayer = (id: string, name: string): EnginePlayerData =>
  ({ id, name, position: "FW" }) as unknown as EnginePlayerData;

const snapshot = (events: MatchEvent[] = []): MatchSnapshot =>
  ({
    home_team: { id: "h", name: "Home FC", players: [makePlayer("p1", "Haaland")] },
    away_team: {
      id: "a",
      name: "Away FC",
      players: [makePlayer("p2", "Mbappe"), makePlayer("p3", "Marquinhos")],
    },
    home_bench: [],
    away_bench: [],
    events,
  }) as unknown as MatchSnapshot;

const goal = (minute: number, player_id: string): MatchEvent => ({
  minute,
  event_type: "Goal",
  side: "Home",
  zone: "AwayBox",
  player_id,
  secondary_player_id: null,
  detail: { Goal: { context: "Extends" } },
});

let previousLanguage: string;

beforeAll(async () => {
  await i18nReady;
  previousLanguage = i18n.language;
  await i18n.changeLanguage("en");
});

afterAll(async () => {
  await i18n.changeLanguage(previousLanguage);
});

describe("getCommentary", () => {
  it("returns null for events with no commentary", () => {
    const evt: MatchEvent = {
      minute: 5,
      event_type: "ShotOnTarget",
      side: "Home",
      zone: "AwayBox",
      player_id: "p1",
      secondary_player_id: null,
    };
    expect(getCommentary(evt, snapshot(), i18n.t.bind(i18n))).toBeNull();
  });

  it("describes open play, naming the player", () => {
    const evt: MatchEvent = {
      minute: 5,
      event_type: "PassCompleted",
      side: "Home",
      zone: "Midfield",
      player_id: "p1",
      secondary_player_id: null,
      second: 14,
      x: 50,
      y: 34,
    };
    const result = getCommentary(evt, snapshot(), i18n.t.bind(i18n));
    expect(result?.headline).toBe("Pass");
    expect(result?.line).toContain("Haaland");
    expect(result?.line).not.toMatch(/flank|wing|wide/);
  });

  it("uses the flank wording when the pass is played out wide", () => {
    const evt: MatchEvent = {
      minute: 5,
      event_type: "PassCompleted",
      side: "Home",
      zone: "Midfield",
      player_id: "p1",
      secondary_player_id: null,
      second: 14,
      x: 50,
      y: 4,
    };
    const result = getCommentary(evt, snapshot(), i18n.t.bind(i18n));
    expect(result?.line).toMatch(/flank|wing|wide/);
  });

  it("gives a line to events that have no player, like corners", () => {
    const evt: MatchEvent = {
      minute: 20,
      event_type: "Corner",
      side: "Away",
      zone: "HomeDefense",
      player_id: null,
      secondary_player_id: null,
      x: 0,
      y: 68,
    };
    const result = getCommentary(evt, snapshot(), i18n.t.bind(i18n));
    expect(result?.line).toContain("Away FC");
  });

  it("produces a non-empty headline and line for a goal", () => {
    const evt = goal(10, "p1");
    const result = getCommentary(evt, snapshot([evt]), i18n.t.bind(i18n));
    expect(result).not.toBeNull();
    expect(result!.headline.length).toBeGreaterThan(0);
    expect(result!.line.length).toBeGreaterThan(0);
    expect(result!.line).toContain("Haaland");
  });

  it("is deterministic — same event yields the same line", () => {
    const evt = goal(10, "p1");
    const a = getCommentary(evt, snapshot([evt]), i18n.t.bind(i18n));
    const b = getCommentary(evt, snapshot([evt]), i18n.t.bind(i18n));
    expect(a).toEqual(b);
  });

  it("uses the brace variant for a player's second goal", () => {
    const g1 = goal(10, "p1");
    const g2 = goal(40, "p1");
    const result = getCommentary(g2, snapshot([g1, g2]), i18n.t.bind(i18n));
    expect(result!.line.toLowerCase()).toMatch(/brace|two/);
  });

  it("never leaks unresolved interpolation tokens", () => {
    const evt: MatchEvent = {
      minute: 22,
      event_type: "Foul",
      side: "Away",
      zone: "Midfield",
      player_id: "p3",
      secondary_player_id: "p2",
      detail: { Foul: { severity: "Hard" } },
    };
    const result = getCommentary(evt, snapshot([evt]), i18n.t.bind(i18n));
    expect(result!.line).not.toMatch(/\{\{.*?\}\}/);
  });

  it("falls back to the base key when detail is absent (penalty goal)", () => {
    const evt: MatchEvent = {
      minute: 50,
      event_type: "PenaltyGoal",
      side: "Home",
      zone: "AwayBox",
      player_id: "p1",
      secondary_player_id: null,
    };
    const result = getCommentary(evt, snapshot([evt]), i18n.t.bind(i18n));
    expect(result).not.toBeNull();
    expect(result!.line.length).toBeGreaterThan(0);
  });

  it("uses the hat-trick variant and headline for a player's third goal", () => {
    const g1 = goal(10, "p1");
    const g2 = goal(40, "p1");
    const g3 = goal(70, "p1");
    const result = getCommentary(g3, snapshot([g1, g2, g3]), i18n.t.bind(i18n));
    expect(result!.headline).toBe("HAT-TRICK!");
    expect(result!.line.toLowerCase()).toMatch(/hat-trick|three/);
  });

  it("only uses the hat-trick variant on the third goal", () => {
    const g1 = goal(10, "p1");
    const g2 = goal(40, "p1");
    const g3 = goal(70, "p1");
    const g4 = goal(82, "p1");
    const result = getCommentary(g4, snapshot([g1, g2, g3, g4]), i18n.t.bind(i18n));
    expect(result!.headline).not.toBe("HAT-TRICK!");
    expect(result!.line.toLowerCase()).not.toContain("hat-trick");
  });

  it("falls back from a missing variant key to the base key", () => {
    // ShotBlocked has a "bigChance" variant in en.json but NO "speculative"
    // variant, so a Speculative-danger blocked shot must fall back to the base
    // ShotBlocked commentary rather than returning null.
    const evt: MatchEvent = {
      minute: 33,
      event_type: "ShotBlocked",
      side: "Home",
      zone: "AwayBox",
      player_id: "p1",
      secondary_player_id: null,
      detail: { Shot: { danger: "Speculative" } },
    };
    const result = getCommentary(evt, snapshot([evt]), i18n.t.bind(i18n));
    expect(result).not.toBeNull();
    expect(result!.line.length).toBeGreaterThan(0);
    expect(result!.line).not.toMatch(/\{\{.*?\}\}/);
  });
});

describe("pitch position helpers", () => {
  const at = (side: "Home" | "Away", x: number, y: number): MatchEvent => ({
    minute: 30,
    event_type: "Dribble",
    side,
    zone: "Midfield",
    player_id: "p1",
    secondary_player_id: null,
    second: 7,
    x,
    y,
  });

  it("reads flank and third from the attacking team's point of view", () => {
    expect(getPitchArea(at("Home", 95, 5))).toEqual({ channel: "left", third: "attacking" });
    // The same spot is the away side's own right-back area.
    expect(getPitchArea(at("Away", 95, 5))).toEqual({ channel: "right", third: "defensive" });
    expect(getPitchArea(at("Home", 52, 34))).toEqual({ channel: "centre", third: "middle" });
  });

  it("returns nothing when the event carries no position", () => {
    const evt = at("Home", 0, 0);
    delete evt.x;
    delete evt.y;
    expect(getPitchArea(evt)).toBeNull();
    expect(getPitchAreaLabel(evt, i18n.t.bind(i18n))).toBeNull();
  });

  it("labels the area for the feed", () => {
    expect(getPitchAreaLabel(at("Home", 95, 5), i18n.t.bind(i18n))).toBe(
      "Left flank · Attacking third",
    );
  });

  it("formats the time as mm:ss, falling back to the minute", () => {
    expect(formatEventTime(at("Home", 1, 1))).toBe("30:07");
    const old = at("Home", 1, 1);
    delete old.second;
    expect(formatEventTime(old)).toBe("30'");
  });
});
