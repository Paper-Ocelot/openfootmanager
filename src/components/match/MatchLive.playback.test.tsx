import { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../../i18n";
import type { GameStateData } from "../../store/gameStore";
import type { MatchSnapshot } from "./types";
import MatchLive from "./MatchLive";
vi.mock("../../context/ThemeContext", () => ({
  useTheme: () => ({ theme: "dark", toggleTheme: vi.fn(), setTheme: vi.fn() }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./PitchView", () => ({
  PitchView: ({
    minute,
    paused,
    onPlaybackComplete,
    onPlaybackStart,
  }: {
    minute: number;
    paused: boolean;
    onPlaybackComplete: (minute: number) => void;
    onPlaybackStart: (minute: number) => void;
  }) => (
    <div>
      <span>{paused ? "Scene paused" : "Scene playing"}</span>
      <button type="button" onClick={() => onPlaybackComplete(minute)}>
        Complete scene
      </button>
      <button type="button" onClick={() => onPlaybackStart(minute)}>
        Replay scene
      </button>
    </div>
  ),
}));
const team = (id: string) => ({
  id,
  name: id,
  formation: "4-4-2",
  play_style: "Balanced",
  players: [],
});
const initial = {
  phase: "FirstHalf",
  current_minute: 5,
  home_score: 0,
  away_score: 0,
  possession: "Home",
  ball_zone: "Midfield",
  home_team: team("Home FC"),
  away_team: team("Away FC"),
  home_bench: [],
  away_bench: [],
  home_possession_pct: 50,
  away_possession_pct: 50,
  events: [],
  home_subs_made: 0,
  away_subs_made: 0,
  max_subs: 5,
  home_set_pieces: {},
  away_set_pieces: {},
  substitutions: [],
  sent_off: [],
  home_yellows: {},
  away_yellows: {},
} as unknown as MatchSnapshot;
const game = { teams: [], players: [] } as unknown as GameStateData;
const halftime = vi.fn(),
  fulltime = vi.fn(),
  important = vi.fn();
function Harness() {
  const [snapshot, setSnapshot] = useState(initial);
  return (
    <MatchLive
      snapshot={snapshot}
      gameState={game}
      userSide={null}
      isSpectator
      importantEvents={[]}
      onSnapshotUpdate={setSnapshot}
      onImportantEvent={important}
      onHalfTime={halftime}
      onFullTime={fulltime}
    />
  );
}
beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
describe("match and viewer coordination", () => {
  it("waits for playback, respects pause, and cancels progression when replay starts", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockResolvedValue([]);
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Pitch" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByText("Scene paused")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Complete scene" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Normal" }));
    fireEvent.click(screen.getByRole("button", { name: "Replay scene" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(invoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Complete scene" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(850);
    });
    expect(invoke).toHaveBeenCalledWith("step_live_match", { minutes: 1 });
  });
  it("lets the last scene finish before opening half-time", async () => {
    vi.useFakeTimers();
    vi.mocked(invoke).mockImplementation(async (command) =>
      command === "step_live_match"
        ? [{ phase: "HalfTime", minute: 45, events: [], is_finished: false }]
        : { ...initial, phase: "HalfTime", current_minute: 45 },
    );
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Pitch" }));
    fireEvent.click(screen.getByRole("button", { name: "Complete scene" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(850);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(halftime).not.toHaveBeenCalled();
    expect(screen.getByText("Scene playing")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Complete scene" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(650);
    });
    expect(halftime).toHaveBeenCalledExactlyOnceWith("HalfTime");
  });
});
