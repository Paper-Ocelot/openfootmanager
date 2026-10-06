import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import i18n, { i18nReady } from "../../i18n";
import { PitchView } from "./PitchView";
import type { MinuteFrames } from "./types";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

const frames: MinuteFrames = {
  minute: 12,
  tick_rate_hz: 10,
  pitch_length: 105,
  pitch_width: 68,
  players: [{ player_id: "p1", side: "Home", position: "Midfielder" }],
  frames: [
    {
      tick: 0,
      ball: { x: 50, y: 34, z: 0 },
      players: [{ x: 48, y: 30, z: 0, facing: 0, anim: "KickShort" }],
    },
    {
      tick: 5,
      ball: { x: 60, y: 34, z: 1 },
      players: [{ x: 49, y: 30, z: 0, facing: 0, anim: "Walk" }],
    },
  ],
};

beforeAll(async () => {
  await i18nReady;
  await i18n.changeLanguage("en");
});

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("PitchView", () => {
  it("asks the engine for the minute on show and for each new minute", async () => {
    vi.mocked(invoke).mockResolvedValue(frames);
    const { rerender } = render(
      <PitchView minute={12} playbackMs={800} homeColor="#dc2626" awayColor="#2563eb" />,
    );

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_match_frames", { minute: 12, stride: 5 }),
    );
    expect(screen.getByText("Minute 12")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Top-down view of the pitch" })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Replay this minute" })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Replay this minute" }));

    rerender(<PitchView minute={13} playbackMs={800} homeColor="#dc2626" awayColor="#2563eb" />);
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_match_frames", { minute: 13, stride: 5 }),
    );
  });

  it("says so when the frames cannot be loaded", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invoke).mockRejectedValue("be.error.noActiveLiveMatch");
    render(<PitchView minute={3} playbackMs={800} homeColor="#dc2626" awayColor="#2563eb" />);
    expect(
      await screen.findByText("The pitch view is not available for this minute."),
    ).toBeInTheDocument();
  });

  it("waits for a highlight rather than asking for a minute it has not got", () => {
    vi.mocked(invoke).mockResolvedValue(frames);
    render(
      <PitchView
        minute={null}
        isHighlight
        playbackMs={800}
        homeColor="#dc2626"
        awayColor="#2563eb"
      />,
    );
    expect(screen.getByText("No highlights yet")).toBeInTheDocument();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("labels a held highlight as such", async () => {
    vi.mocked(invoke).mockResolvedValue(frames);
    render(
      <PitchView
        minute={21}
        isHighlight
        playbackMs={800}
        homeColor="#dc2626"
        awayColor="#2563eb"
      />,
    );
    expect(screen.getByText("Latest highlight: minute 21")).toBeInTheDocument();
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith("get_match_frames", { minute: 21, stride: 5 }),
    );
  });
});
