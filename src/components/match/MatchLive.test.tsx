import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../../i18n";
import type { GameStateData } from "../../store/gameStore";
import MatchLive from "./MatchLive";
import type { EnginePlayerData, MatchEvent, MatchSnapshot } from "./types";

vi.mock("../../context/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark", toggleTheme: () => {}, setTheme: () => {} }),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async () => []),
}));

const player = (id: string, name: string): EnginePlayerData =>
  ({ id, name, position: "Midfielder", traits: [] }) as unknown as EnginePlayerData;

const pass: MatchEvent = {
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

const snapshot = {
  phase: "FirstHalf",
  current_minute: 5,
  home_score: 0,
  away_score: 0,
  possession: "Home",
  ball_zone: "Midfield",
  home_team: {
    id: "h",
    name: "Home FC",
    formation: "4-4-2",
    play_style: "Balanced",
    players: [player("p1", "Haaland")],
  },
  away_team: {
    id: "a",
    name: "Away FC",
    formation: "4-4-2",
    play_style: "Balanced",
    players: [player("p2", "Mbappe")],
  },
  home_bench: [],
  away_bench: [],
  home_possession_pct: 50,
  away_possession_pct: 50,
  events: [pass],
  home_subs_made: 0,
  away_subs_made: 0,
  max_subs: 5,
  home_set_pieces: {},
  away_set_pieces: {},
  substitutions: [],
  allows_extra_time: false,
  home_yellows: {},
  away_yellows: {},
  sent_off: [],
} as unknown as MatchSnapshot;

const gameState = { teams: [], players: [] } as unknown as GameStateData;

beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage("en");
});

describe("MatchLive commentary feed", () => {
  it("shows open-play commentary by default and hides it under key moments", () => {
    render(
      <>
        <MatchLive
          snapshot={snapshot}
          gameState={gameState}
          userSide={null}
          isSpectator
          importantEvents={[]}
          onSnapshotUpdate={() => {}}
          onImportantEvent={() => {}}
          onHalfTime={() => {}}
          onFullTime={() => {}}
        />
      </>,
    );

    expect(screen.getByText(/Haaland/)).toBeInTheDocument();
    expect(screen.getByText("5:14")).toBeInTheDocument();
    expect(screen.getByText("Central · Middle third")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Key moments" }));
    expect(screen.queryByText("5:14")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Full commentary" }));
    expect(screen.getByText("5:14")).toBeInTheDocument();
  });
});
