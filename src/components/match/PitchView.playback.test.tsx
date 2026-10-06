import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../../i18n";
import { PitchView } from "./PitchView";
import type { MinuteFrames } from "./types";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage("en");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const frames: MinuteFrames = {
  minute: 12,
  tick_rate_hz: 10,
  pitch_length: 105,
  pitch_width: 68,
  players: [{ player_id: "p1", side: "Home", position: "Forward" }],
  frames: [0, 599].map((tick) => ({
    tick,
    ball: { x: tick / 10, y: 34, z: 0 },
    players: [{ x: 50, y: 34, z: 0, facing: 0, anim: "Sprint" }],
  })),
};
const props = { minute: 12, playbackMs: 1200, homeColor: "red", awayColor: "blue" };
function animationClock() {
  let now = 0,
    id = 0;
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const scheduled = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    scheduled.set(++id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (key: number) => scheduled.delete(key));
  return {
    advance: (ms: number) => {
      for (let step = 0; step < ms; step += 100) {
        now += 100;
        const pending = [...scheduled.values()];
        scheduled.clear();
        act(() => {
          for (const callback of pending) callback(now);
        });
      }
    },
    scheduled,
  };
}
describe("pitch playback controls", () => {
  it("freezes while paused, resumes in place, and replays twice without another engine request", async () => {
    const clock = animationClock();
    vi.mocked(invoke).mockReset().mockResolvedValue(frames);
    const complete = vi.fn();
    const { rerender, unmount } = render(<PitchView {...props} onPlaybackComplete={complete} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Replay this minute" })).toBeEnabled(),
    );
    clock.advance(400);
    const slider = screen.getByRole("slider") as HTMLInputElement;
    const position = Number(slider.value);
    expect(position).toBeGreaterThan(0);
    rerender(<PitchView {...props} paused onPlaybackComplete={complete} />);
    clock.advance(1000);
    expect(Number(slider.value)).toBe(position);
    rerender(<PitchView {...props} onPlaybackComplete={complete} />);
    clock.advance(900);
    expect(complete).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Replay this minute" }));
    expect(Number(slider.value)).toBe(0);
    clock.advance(300);
    expect(Number(slider.value)).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Skip to end" }));
    expect(complete).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole("button", { name: "Replay this minute" }));
    clock.advance(300);
    expect(Number(slider.value)).toBeGreaterThan(0);
    expect(invoke).toHaveBeenCalledTimes(1);
    unmount();
    expect(clock.scheduled.size).toBe(0);
  });
  it("ignores an older request that finishes after the current minute", async () => {
    let resolveOld!: (value: MinuteFrames) => void;
    vi.mocked(invoke)
      .mockReset()
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveOld = resolve;
        }),
      )
      .mockResolvedValueOnce({ ...frames, minute: 13 });
    const { rerender } = render(<PitchView {...props} paused />);
    rerender(<PitchView {...props} minute={13} paused playerJerseyMap={new Map([["p1", 9]])} />);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Replay this minute" })).toBeEnabled(),
    );
    await act(async () => resolveOld({ ...frames, players: [] }));
    expect(screen.getByText("9")).toBeInTheDocument();
    expect(screen.getByText("Minute 13")).toBeInTheDocument();
  });
  it("releases match progression on an empty response rather than hanging forever", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke)
      .mockReset()
      .mockResolvedValue({ ...frames, frames: [] });
    const complete = vi.fn();
    render(<PitchView {...props} onPlaybackComplete={complete} />);
    await screen.findByText("The pitch view is not available for this minute.");
    expect(complete).toHaveBeenCalledWith(12);
    expect(screen.getByRole("slider")).toBeDisabled();
  });
});
