import { describe, expect, it } from "vitest";
import { interpolateFrame, isActionAnim } from "./pitchFrames";
import type { MatchFrame } from "./types";

const frame = (tick: number, x: number, facing: number, ballZ: number): MatchFrame => ({
  tick,
  ball: { x, y: 34, z: ballZ },
  players: [{ x, y: 10, z: 0, facing, anim: tick === 0 ? "KickShort" : "Sprint" }],
});

describe("interpolateFrame", () => {
  const frames = [frame(0, 10, 3, 0), frame(5, 20, -3, 4)];

  it("returns nothing when there are no frames", () => {
    expect(interpolateFrame([], 0.5)).toBeNull();
  });

  it("returns the snapshots themselves at the ends, even past them", () => {
    expect(interpolateFrame(frames, 0)).toBe(frames[0]);
    expect(interpolateFrame(frames, 1)).toBe(frames[1]);
    expect(interpolateFrame(frames, 7)).toBe(frames[1]);
    expect(interpolateFrame(frames, -2)).toBe(frames[0]);
  });

  it("glides the ball and players between snapshots", () => {
    const mid = interpolateFrame(frames, 0.5);
    expect(mid?.ball.x).toBeCloseTo(15);
    expect(mid?.ball.z).toBeCloseTo(2);
    expect(mid?.players[0].x).toBeCloseTo(15);
    expect(mid?.players[0].anim).toBe("KickShort");
  });

  it("turns the short way round rather than spinning through zero", () => {
    // From 3 rad to -3 rad is a small turn through pi, not a spin through 0.
    const mid = interpolateFrame(frames, 0.5);
    expect(Math.abs(mid?.players[0].facing ?? 0)).toBeGreaterThan(3);
  });
});

describe("isActionAnim", () => {
  it("separates one-off actions from standing and running", () => {
    expect(isActionAnim("KickPower")).toBe(true);
    expect(isActionAnim("KeeperDiveLeft")).toBe(true);
    expect(isActionAnim("Sprint")).toBe(false);
    expect(isActionAnim("Idle")).toBe(false);
  });
});
