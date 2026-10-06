import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { RotateCcw } from "lucide-react";
import { interpolateFrame, isActionAnim } from "./pitchFrames";
import type { FramePlayer, MatchFrame, MinuteFrames } from "./types";

/**
 * Keep every 5th of the engine's ten snapshots a second. Two a second is
 * plenty for a view that glides between them, and keeps fast-forward light.
 * A 3D viewer would ask for all of them (leave `stride` out).
 */
const SNAPSHOT_STRIDE = 5;
/** How long a replay of one match minute takes, in milliseconds. */
const REPLAY_MS = 12000;
/** How long a highlight takes to play out, however fast the match is running. */
const HIGHLIGHT_MS = 6000;
/** Grass shown around the touchlines, in metres, so the goals and corners fit. */
const MARGIN = 3;

// Canvas drawing cannot use Tailwind classes, so the pitch palette lives here.
const GRASS = "#2f7d4f";
const GRASS_STRIPE = "#2a7247";
const LINE = "rgba(255, 255, 255, 0.85)";
const ACTION_RING = "#facc15";
const BALL = "#ffffff";
const SHADOW = "rgba(0, 0, 0, 0.35)";

interface PitchViewProps {
  /** The match minute to show, or null when there is nothing to show yet. */
  minute: number | null;
  /** Whether this is a highlight being held on screen rather than live play. */
  isHighlight?: boolean;
  /** How long to take playing the minute out, in milliseconds. */
  playbackMs: number;
  homeColor: string;
  awayColor: string;
}

function drawMarkings(ctx: CanvasRenderingContext2D, length: number, width: number, s: number) {
  // Mown stripes.
  const stripes = 12;
  for (let i = 0; i < stripes; i++) {
    ctx.fillStyle = i % 2 === 0 ? GRASS : GRASS_STRIPE;
    ctx.fillRect(((length * i) / stripes) * s, 0, (length / stripes) * s + 1, width * s);
  }

  ctx.strokeStyle = LINE;
  ctx.fillStyle = LINE;
  ctx.lineWidth = Math.max(1, 0.18 * s);
  ctx.strokeRect(0, 0, length * s, width * s);

  // Halfway line, centre circle and spot.
  ctx.beginPath();
  ctx.moveTo((length / 2) * s, 0);
  ctx.lineTo((length / 2) * s, width * s);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc((length / 2) * s, (width / 2) * s, 9.15 * s, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc((length / 2) * s, (width / 2) * s, 0.35 * s, 0, Math.PI * 2);
  ctx.fill();

  // Penalty areas, six-yard boxes, penalty spots and goals at both ends.
  for (const end of [0, 1]) {
    const x = (depth: number) => (end === 0 ? depth : length - depth) * s;
    const box = (depth: number, across: number) => {
      const left = Math.min(x(0), x(depth));
      ctx.strokeRect(left, ((width - across) / 2) * s, depth * s, across * s);
    };
    box(16.5, 40.32);
    box(5.5, 18.32);
    ctx.beginPath();
    ctx.arc(x(11), (width / 2) * s, 0.35 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeRect(Math.min(x(0), x(-2)), ((width - 7.32) / 2) * s, 2 * s, 7.32 * s);
  }
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  frame: MatchFrame,
  roster: FramePlayer[],
  s: number,
  colors: { home: string; away: string },
) {
  const radius = Math.max(4, 1.25 * s);

  frame.players.forEach((who, i) => {
    const info = roster[i];
    if (!info) return;
    const cx = who.x * s;
    const groundY = who.y * s;
    // Height lifts the marker up the screen and leaves its shadow on the grass.
    const cy = groundY - who.z * s * 2;

    if (who.z > 0.02) {
      ctx.fillStyle = SHADOW;
      ctx.beginPath();
      ctx.ellipse(cx, groundY, radius, radius * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.fillStyle = info.side === "Home" ? colors.home : colors.away;
    ctx.fill();
    ctx.lineWidth = Math.max(1, 0.25 * s);
    ctx.strokeStyle = info.position === "Goalkeeper" ? "#111827" : "#ffffff";
    ctx.stroke();

    // A short line shows which way the player is facing.
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(who.facing) * radius * 1.7, cy + Math.sin(who.facing) * radius * 1.7);
    ctx.strokeStyle = "#ffffff";
    ctx.stroke();

    // Kicks, tackles, headers and dives get a ring so they stand out.
    if (isActionAnim(who.anim)) {
      ctx.beginPath();
      ctx.arc(cx, cy, radius * 1.6, 0, Math.PI * 2);
      ctx.strokeStyle = ACTION_RING;
      ctx.lineWidth = Math.max(1.5, 0.3 * s);
      ctx.stroke();
    }
  });

  const ball = frame.ball;
  const ballRadius = Math.max(2.5, (0.55 + ball.z * 0.06) * s);
  ctx.fillStyle = SHADOW;
  ctx.beginPath();
  ctx.ellipse(ball.x * s, ball.y * s, ballRadius, ballRadius * 0.55, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = BALL;
  ctx.strokeStyle = "#111827";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(ball.x * s, ball.y * s - ball.z * s * 2, ballRadius, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

/**
 * A top-down view of the pitch that plays out one match minute from the
 * engine's frame-by-frame data: all the players, the ball and its height.
 * It is the simple stand-in for a 3D viewer, drawing the very same data.
 */
export function PitchView({
  minute,
  isHighlight = false,
  playbackMs,
  homeColor,
  awayColor,
}: PitchViewProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [data, setData] = useState<MinuteFrames | null>(null);
  const [failed, setFailed] = useState(false);
  const [width, setWidth] = useState(0);
  // Bumped to play the current minute again, slowly.
  const [replay, setReplay] = useState(0);

  // Fetch the frames for the minute on show.
  useEffect(() => {
    if (minute === null) {
      setData(null);
      return;
    }
    let cancelled = false;
    invoke<MinuteFrames>("get_match_frames", { minute, stride: SNAPSHOT_STRIDE })
      .then((frames) => {
        if (cancelled) return;
        setFailed(false);
        setData(frames);
        setReplay(0);
      })
      .catch((error) => {
        console.error("[PitchView] could not load match frames:", error);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [minute]);

  // Follow the size of the panel.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = () => setWidth(container.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const draw = useCallback(
    (progress: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !data || width === 0) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      const ratio = window.devicePixelRatio || 1;
      const scale = width / (data.pitch_length + MARGIN * 2);
      const height = (data.pitch_width + MARGIN * 2) * scale;
      if (canvas.width !== Math.round(width * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.fillStyle = GRASS_STRIPE;
      ctx.fillRect(0, 0, width, height);
      ctx.translate(MARGIN * scale, MARGIN * scale);
      drawMarkings(ctx, data.pitch_length, data.pitch_width, scale);
      const frame = interpolateFrame(data.frames, progress);
      if (frame) drawFrame(ctx, frame, data.players, scale, { home: homeColor, away: awayColor });
    },
    [data, width, homeColor, awayColor],
  );

  // Play the minute out, then hold on its last moment.
  useEffect(() => {
    if (!data) return;
    const live = isHighlight ? HIGHLIGHT_MS : Math.max(playbackMs, 600);
    const duration = replay > 0 ? REPLAY_MS : live;
    const startedAt = performance.now();
    let handle = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      draw(progress);
      if (progress < 1) handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [data, draw, playbackMs, replay, isHighlight]);

  const height =
    data && width > 0
      ? ((data.pitch_width + MARGIN * 2) * width) / (data.pitch_length + MARGIN * 2)
      : 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="font-heading text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {minute === null
            ? t("match.pitchWaiting", "No highlights yet")
            : isHighlight
              ? t("match.pitchHighlightMinute", {
                  defaultValue: "Latest highlight: minute {{minute}}",
                  minute,
                })
              : t("match.pitchMinute", { defaultValue: "Minute {{minute}}", minute })}
        </p>
        <button
          type="button"
          onClick={() => setReplay((count) => count + 1)}
          disabled={!data}
          className="flex items-center gap-2 rounded-full bg-gray-200 px-3 py-1 font-heading text-xs font-bold uppercase tracking-wider text-gray-600 transition-colors hover:bg-gray-300 disabled:opacity-50 dark:bg-navy-700 dark:text-gray-300 dark:hover:bg-navy-600"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          {t("match.pitchReplay", "Replay this minute")}
        </button>
      </div>
      <div ref={containerRef} className="w-full overflow-hidden rounded-lg">
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={t("match.pitchLabel", "Top-down view of the pitch")}
          style={{ width: "100%", height: height > 0 ? `${height}px` : undefined }}
        />
      </div>
      <p className="text-xs text-gray-500 dark:text-gray-400">
        {minute === null
          ? t(
              "match.pitchWaitingNote",
              "The pitch will show the next highlight as soon as there is one.",
            )
          : failed
            ? t("match.pitchUnavailable", "The pitch view is not available for this minute.")
            : t(
                "match.pitchNote",
                "Player movement is worked out from the match events. A yellow ring marks a kick, tackle, header or save.",
              )}
      </p>
    </div>
  );
}
