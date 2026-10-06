import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { RotateCcw, SkipForward } from "lucide-react";
import { interpolateFrame } from "./pitchFrames";
import { eventAtCursor } from "./pitchPlayback";
import { getCommentary } from "./commentary";
import { PitchScene } from "./PitchScene";
import type { MatchSnapshot, MinuteFrames } from "./types";

interface PitchViewProps {
  minute: number | null;
  isHighlight?: boolean;
  playbackMs: number;
  homeColor: string;
  awayColor: string;
  paused?: boolean;
  snapshot?: MatchSnapshot;
  playerJerseyMap?: ReadonlyMap<string, number>;
  onPlaybackStart?: (minute: number) => void;
  onPlaybackComplete?: (minute: number) => void;
  onCursorChange?: (minute: number, second: number) => void;
}

/** Plays the mod's recorded reconstruction. Viewing and seeking never issue a match command. */
export function PitchView({
  minute,
  isHighlight = false,
  playbackMs,
  homeColor,
  awayColor,
  paused = false,
  snapshot,
  playerJerseyMap,
  onPlaybackStart,
  onPlaybackComplete,
  onCursorChange,
}: PitchViewProps) {
  const { t } = useTranslation();
  const [loaded, setLoaded] = useState<{ minute: number; data: MinuteFrames } | null>(null);
  const [failed, setFailed] = useState(false);
  const [progress, setProgress] = useState(0);
  const [replaying, setReplaying] = useState(false);
  const [seekVersion, setSeekVersion] = useState(0);
  const progressRef = useRef(0);
  const completedRef = useRef(false);
  const callbacks = useRef({ onPlaybackStart, onPlaybackComplete, onCursorChange });
  useEffect(() => {
    callbacks.current = { onPlaybackStart, onPlaybackComplete, onCursorChange };
  }, [onPlaybackStart, onPlaybackComplete, onCursorChange]);
  const data = loaded?.minute === minute ? loaded.data : null;

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFailed(false);
    setReplaying(false);
    setProgress(0);
    progressRef.current = 0;
    completedRef.current = false;
    if (minute === null) return;
    callbacks.current.onPlaybackStart?.(minute);
    callbacks.current.onCursorChange?.(minute, 0);
    // Keep all ten samples per second: thinning can lose short kicks and saves.
    invoke<MinuteFrames>("get_match_frames", { minute, stride: 1 })
      .then((data) => {
        if (cancelled) return;
        if (
          !data?.frames?.length ||
          !(data.tick_rate_hz > 0) ||
          !(data.pitch_length > 0) ||
          !(data.pitch_width > 0)
        ) {
          throw new Error("No playable frames");
        }
        setLoaded({ minute, data });
      })
      .catch((error) => {
        if (cancelled) return;
        console.error("[PitchView] could not load match frames:", error);
        setFailed(true);
        callbacks.current.onPlaybackComplete?.(minute);
      });
    return () => {
      cancelled = true;
    };
  }, [minute]);

  const duration = replaying ? 12000 : Math.max(playbackMs, isHighlight ? 6000 : 1200);
  useEffect(() => {
    if (!data || paused) return;
    let handle = 0;
    let previous = performance.now();
    const step = (now: number) => {
      // Returning from a hidden window must not skip the whole scene.
      const elapsed = document.hidden ? 0 : Math.min(Math.max(now - previous, 0), 100);
      previous = now;
      progressRef.current = Math.min(1, progressRef.current + elapsed / duration);
      setProgress(progressRef.current);
      if (progressRef.current < 1) handle = requestAnimationFrame(step);
    };
    handle = requestAnimationFrame(step);
    return () => cancelAnimationFrame(handle);
  }, [data, paused, duration, replaying, seekVersion]);

  const frame = data ? interpolateFrame(data.frames, progress) : null;
  const second =
    data && frame ? Math.min(59.9, Math.round((frame.tick / data.tick_rate_hz) * 10) / 10) : 0;
  useEffect(() => {
    if (minute !== null && data) callbacks.current.onCursorChange?.(minute, second);
  }, [minute, second, data]);
  useEffect(() => {
    if (minute !== null && data && progress >= 1 && !completedRef.current) {
      completedRef.current = true;
      callbacks.current.onPlaybackComplete?.(minute);
    }
  }, [minute, data, progress]);

  const names = useMemo(
    () =>
      new Map(
        [
          ...(snapshot?.home_team.players ?? []),
          ...(snapshot?.away_team.players ?? []),
          ...(snapshot?.home_bench ?? []),
          ...(snapshot?.away_bench ?? []),
        ].map((player) => [player.id, player.name]),
      ),
    [snapshot],
  );
  const event =
    snapshot && minute !== null ? eventAtCursor(snapshot.events, minute, second) : undefined;
  const commentary = event && snapshot ? getCommentary(event, snapshot, t) : null;
  const seek = (value: number) => {
    if (!data || minute === null) return;
    callbacks.current.onPlaybackStart?.(minute);
    completedRef.current = false;
    progressRef.current = value;
    setSeekVersion((version) => version + 1);
    setProgress(value);
  };
  const buttonClass =
    "flex items-center gap-2 rounded-lg bg-gray-200 px-3 py-2 font-heading text-xs font-bold uppercase tracking-wider text-gray-700 hover:bg-gray-300 disabled:opacity-40 dark:bg-navy-700 dark:text-gray-200 dark:hover:bg-navy-600";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="font-heading text-xs font-bold uppercase tracking-wider text-gray-600 dark:text-gray-300">
          {minute === null
            ? t("match.pitchWaiting")
            : isHighlight
              ? t("match.pitchHighlightMinute", { minute })
              : t("match.pitchMinute", { minute })}
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={!data}
            onClick={() => {
              setReplaying(true);
              seek(0);
            }}
          >
            <RotateCcw className="h-3.5 w-3.5" />
            {t("match.pitchReplay")}
          </button>
          <button
            type="button"
            className={buttonClass}
            disabled={!data || progress >= 1}
            onClick={() => seek(1)}
          >
            <SkipForward className="h-3.5 w-3.5" />
            {t("match.pitchSkip")}
          </button>
        </div>
      </div>
      {snapshot && (
        <div className="flex justify-between gap-3 font-heading text-sm font-bold text-gray-700 dark:text-gray-200">
          <span className="flex items-center gap-2">
            <span
              className="h-3 w-3 rounded-full border-2 border-white"
              style={{ backgroundColor: homeColor }}
            />
            {snapshot.home_team.name}
          </span>
          <span className="flex items-center gap-2">
            {snapshot.away_team.name}
            <span
              className="h-3 w-3 rounded-full border-2 border-navy-900"
              style={{ backgroundColor: awayColor }}
            />
          </span>
        </div>
      )}
      <PitchScene
        data={data}
        frame={frame}
        homeColor={homeColor}
        awayColor={awayColor}
        label={t("match.pitchLabel")}
        jerseys={playerJerseyMap}
        names={names}
      />
      <div className="flex items-center gap-3">
        <span className="min-w-12 font-heading text-sm tabular-nums text-gray-600 dark:text-gray-300">
          {minute ?? 0}:{String(Math.floor(second)).padStart(2, "0")}
        </span>
        <input
          type="range"
          min="0"
          max="1000"
          value={Math.round(progress * 1000)}
          disabled={!data}
          aria-label={t("match.pitchTimeline")}
          className="w-full accent-primary-500"
          onChange={(event) => seek(Number(event.target.value) / 1000)}
        />
      </div>
      {commentary && (
        <div className="min-h-16 rounded-lg border border-gray-200 bg-white p-3 dark:border-navy-700 dark:bg-navy-800">
          <p className="font-heading text-sm font-bold uppercase text-primary-600 dark:text-primary-400">
            {commentary.headline}
          </p>
          <p className="text-sm text-gray-700 dark:text-gray-200">{commentary.line}</p>
        </div>
      )}
      <p className="text-xs text-gray-500 dark:text-gray-400" role="status">
        {minute === null
          ? t("match.pitchWaitingNote")
          : failed
            ? t("match.pitchUnavailable")
            : !data
              ? t("match.pitchLoading")
              : t("match.pitchNote")}
      </p>
    </div>
  );
}
