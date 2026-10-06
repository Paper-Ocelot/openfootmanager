import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import type { GameStateData } from "../../store/gameStore";
import {
  type MatchSnapshot,
  type MatchEvent,
  type MinuteResult,
  type SimSpeed,
  SPEED_MS,
  MINUTES_PER_TICK,
  FORMATIONS,
  isPersistableSpeed,
} from "./types";
import { getEventDisplay, getPlayerName, makeTeamFallback, phaseLabel } from "./helpers";
import { Badge, TeamLogo } from "../ui";
import { useSettingsStore } from "../../store/settingsStore";
import { EventFeed, MatchStats, Lineups } from "./MatchPanels";
import { PitchView } from "./PitchView";
import { eventPlaybackSecond, scoreAtCursor } from "./pitchPlayback";
import { HIGHLIGHT_MODES, type HighlightMode, eventsForMode, minuteToWatch } from "./highlights";
import MatchScreenLayout from "./MatchScreenLayout";
import { SubPanel } from "./SubPanel";
import {
  Play,
  Pause,
  FastForward,
  SkipForward,
  Clock,
  Users,
  BarChart3,
  MessageSquare,
  RefreshCw,
  ChevronRight,
  Zap,
  Shield,
  Crosshair,
  Target,
  Flag,
  Map as MapIcon,
} from "lucide-react";

type ActivePanel = "events" | "pitch" | "stats" | "lineups";

interface MatchLiveProps {
  snapshot: MatchSnapshot;
  gameState: GameStateData;
  userSide: "Home" | "Away" | null;
  isSpectator: boolean;
  importantEvents: MatchEvent[];
  preferredSpeed?: "slow" | "normal" | "fast";
  onPreferredSpeedChange?: (speed: "slow" | "normal" | "fast") => void;
  onSnapshotUpdate: (snap: MatchSnapshot) => void;
  onImportantEvent: (evt: MatchEvent) => void;
  onHalfTime: (phase: "HalfTime" | "ExtraTimeHalfTime") => void;
  onFullTime: () => void;
  onPenaltyShootout?: () => void;
}

export default function MatchLive({
  snapshot,
  gameState,
  userSide,
  isSpectator,
  importantEvents,
  preferredSpeed,
  onPreferredSpeedChange,
  onSnapshotUpdate,
  onImportantEvent,
  onHalfTime,
  onFullTime,
  onPenaltyShootout,
}: MatchLiveProps) {
  const { t } = useTranslation();
  const { settings } = useSettingsStore();
  const initialSpeed: SimSpeed =
    preferredSpeed ??
    (settings.match_speed === "slow" || settings.match_speed === "fast"
      ? settings.match_speed
      : "normal");
  const [speed, setSpeed] = useState<SimSpeed>(initialSpeed);
  const [activePanel, setActivePanel] = useState<ActivePanel>("events");
  // One setting for the commentary and the pitch view alike: key highlights
  // (goals, cards, changes), extended highlights (plus chances and set
  // pieces) or the full game.
  const [highlightMode, setHighlightMode] = useState<HighlightMode>("full");
  // Newest first, so the latest event is always at the top of the feed.
  const feedEvents = useMemo(
    () => [...eventsForMode(snapshot.events, highlightMode)].reverse(),
    [snapshot.events, highlightMode],
  );
  const pitchMinute =
    snapshot.current_minute > 0
      ? minuteToWatch(snapshot.events, highlightMode, snapshot.current_minute)
      : null;
  const [pitchPlayback, setPitchPlayback] = useState({ minute: -1, second: 0, complete: false });
  const [pendingPhase, setPendingPhase] = useState<string | null>(null);
  const steppingRef = useRef(false);
  const pitchPending =
    activePanel === "pitch" &&
    pitchMinute !== null &&
    (pitchPlayback.minute !== pitchMinute || !pitchPlayback.complete);
  const startPitch = useCallback(
    (minute: number) => setPitchPlayback({ minute, second: 0, complete: false }),
    [],
  );
  const finishPitch = useCallback(
    (minute: number) => setPitchPlayback({ minute, second: 60, complete: true }),
    [],
  );
  const movePitch = useCallback(
    (minute: number, second: number) =>
      setPitchPlayback((current) =>
        current.minute === minute && current.second === second
          ? current
          : { ...current, minute, second },
      ),
    [],
  );
  const displayScore =
    activePanel === "pitch" && pitchMinute !== null
      ? scoreAtCursor(
          snapshot,
          pitchMinute,
          pitchPlayback.minute === pitchMinute ? pitchPlayback.second : 0,
        )
      : { home: snapshot.home_score, away: snapshot.away_score };
  const displayMinute =
    activePanel === "pitch" && pitchMinute !== null ? pitchMinute : snapshot.current_minute;
  const visibleImportantEvents =
    activePanel === "pitch" && pitchMinute !== null
      ? importantEvents.filter(
          (event) =>
            event.minute < pitchMinute ||
            (event.minute === pitchMinute &&
              eventPlaybackSecond(event) <=
                (pitchPlayback.minute === pitchMinute ? pitchPlayback.second : 0)),
        )
      : importantEvents;
  const [isRunning, setIsRunning] = useState(true);
  const [showSubPanel, setShowSubPanel] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const eventFeedRef = useRef<HTMLDivElement>(null);
  // Track phases we've already signaled to avoid double-firing
  const signaledRef = useRef<Set<string>>(new Set());

  const homeFullTeam = gameState.teams.find((t) => t.id === snapshot.home_team.id);
  const awayFullTeam = gameState.teams.find((t) => t.id === snapshot.away_team.id);
  const homeTeamColor = homeFullTeam?.colors?.primary || "#10b981";
  const awayTeamColor = awayFullTeam?.colors?.primary || "#6366f1";

  const playerJerseyMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of gameState.players) {
      if (p.jersey_number != null) m.set(p.id, p.jersey_number);
    }
    return m;
  }, [gameState.players]);

  const isFinished = snapshot.phase === "Finished";

  // Reads only `lastResult` for phase transitions, which is sound because step_many stops on
  // entering any phase that needs the manager — so a half time, shootout or finish is always the
  // last entry of a batch, never buried in the middle. See `phase_needs_manager` in
  // ofm_core/live_match_manager.rs; MINUTES_PER_TICK on this side is what makes batches possible.
  const stepMatch = useCallback(
    async (minutes: number) => {
      if (steppingRef.current) return;
      steppingRef.current = true;
      try {
        const results = await invoke<MinuteResult[]>("step_live_match", { minutes });
        if (results.length > 0) {
          const lastResult = results[results.length - 1];

          // Collect important events
          for (const r of results) {
            for (const evt of r.events) {
              const display = getEventDisplay(evt);
              if (display.important) {
                onImportantEvent(evt);
              }
            }
          }

          // Fetch full snapshot
          const snap = await invoke<MatchSnapshot>("get_match_snapshot");
          onSnapshotUpdate(snap);

          // Check for phase transitions that should pause
          const phase = lastResult.phase;
          if (phase === "HalfTime" && !signaledRef.current.has("HalfTime")) {
            signaledRef.current.add("HalfTime");
            setPendingPhase("HalfTime");
            return;
          }

          if (phase === "ExtraTimeHalfTime" && !signaledRef.current.has("ExtraTimeHalfTime")) {
            signaledRef.current.add("ExtraTimeHalfTime");
            setPendingPhase("ExtraTimeHalfTime");
            return;
          }

          if (phase === "PenaltyShootout" && !signaledRef.current.has("PenaltyShootout")) {
            signaledRef.current.add("PenaltyShootout");
            setPendingPhase("PenaltyShootout");
            return;
          }

          if (lastResult.is_finished && !signaledRef.current.has("Finished")) {
            signaledRef.current.add("Finished");
            setPendingPhase("Finished");
            return;
          }
        }
      } catch (err) {
        console.error("Failed to step match:", err);
        setIsRunning(false);
      } finally {
        steppingRef.current = false;
      }
    },
    [onSnapshotUpdate, onImportantEvent, onHalfTime, onFullTime, onPenaltyShootout],
  );

  // Finish the last scene before opening half-time, shootout or the final report.
  useEffect(() => {
    if (!pendingPhase || pitchPending) return;
    const timer = setTimeout(() => {
      setIsRunning(false);
      setSpeed("paused");
      setPendingPhase(null);
      if (pendingPhase === "HalfTime" || pendingPhase === "ExtraTimeHalfTime")
        onHalfTime(pendingPhase);
      else if (pendingPhase === "PenaltyShootout") onPenaltyShootout?.();
      else onFullTime();
    }, 600);
    return () => clearTimeout(timer);
  }, [pendingPhase, pitchPending, onHalfTime, onPenaltyShootout, onFullTime]);

  // Auto-step timer
  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (
      isRunning &&
      speed !== "paused" &&
      !isFinished &&
      !showSubPanel &&
      !pitchPending &&
      !pendingPhase
    ) {
      timerRef.current = setTimeout(async () => {
        await stepMatch(activePanel === "pitch" ? 1 : MINUTES_PER_TICK[speed]);
      }, SPEED_MS[speed]);
    }

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [
    isRunning,
    speed,
    snapshot.current_minute,
    snapshot.phase,
    stepMatch,
    isFinished,
    showSubPanel,
    pitchPending,
    pendingPhase,
    activePanel,
  ]);

  // No auto-scroll: new events arrive at the top, where the feed already sits.
  // Someone who has scrolled down to read back is left where they are.

  // Apply substitution
  const handleSubstitution = async (playerOffId: string, playerOnId: string) => {
    if (!userSide || isSpectator) return;
    try {
      const snap = await invoke<MatchSnapshot>("apply_match_command", {
        command: {
          Substitute: { side: userSide, player_off_id: playerOffId, player_on_id: playerOnId },
        },
      });
      onSnapshotUpdate(snap);
      setShowSubPanel(false);
    } catch (err) {
      console.error("Substitution failed:", err);
    }
  };

  const handleFormationChange = async (formation: string) => {
    if (!userSide || isSpectator) return;
    try {
      const snap = await invoke<MatchSnapshot>("apply_match_command", {
        command: { ChangeFormation: { side: userSide, formation } },
      });
      onSnapshotUpdate(snap);
    } catch (err) {
      console.error("Formation change failed:", err);
    }
  };

  const handlePlayStyleChange = async (playStyle: string) => {
    if (!userSide || isSpectator) return;
    try {
      const snap = await invoke<MatchSnapshot>("apply_match_command", {
        command: { ChangePlayStyle: { side: userSide, play_style: playStyle } },
      });
      onSnapshotUpdate(snap);
    } catch (err) {
      console.error("Play style change failed:", err);
    }
  };

  return (
    <MatchScreenLayout
      headerClassName="bg-linear-to-r from-gray-200 via-white to-gray-200 dark:from-navy-800 dark:via-navy-900 dark:to-navy-800"
      headerContentClassName="max-w-7xl py-3"
      contentClassName="overflow-hidden"
      header={
        <>
          <div className="flex items-center justify-between gap-4">
            {/* Live indicator */}
            <div className="flex items-center gap-2">
              {isRunning && (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-red-500" />
                </span>
              )}
              <span className="text-xs font-heading uppercase tracking-widest text-gray-500 dark:text-gray-400">
                {isRunning ? t("match.live") : t("match.paused")}
              </span>
            </div>

            {/* Scoreboard */}
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-3">
                <div className="text-right">
                  <p className="font-heading font-bold text-sm uppercase tracking-wider text-gray-800 dark:text-gray-200">
                    {snapshot.home_team.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {snapshot.home_team.formation}
                  </p>
                </div>
                <TeamLogo
                  team={homeFullTeam ?? makeTeamFallback(snapshot.home_team.name)}
                  className="w-10 h-10 rounded-lg flex items-center justify-center font-heading font-bold text-sm overflow-hidden"
                  imageClassName="h-8 w-8 object-contain drop-shadow"
                  style={{
                    backgroundColor: `${homeTeamColor}30`,
                    borderColor: homeTeamColor,
                    borderWidth: 2,
                  }}
                />
              </div>

              <div className="flex items-center gap-3">
                <span className="text-4xl font-heading font-bold text-gray-900 dark:text-white tabular-nums">
                  {displayScore.home}
                </span>
                <div className="flex flex-col items-center">
                  <span className="text-xs font-heading uppercase tracking-widest text-accent-700 dark:text-accent-400">
                    {phaseLabel(snapshot.phase, t)}
                  </span>
                  <span className="text-2xl font-heading font-bold text-gray-500 dark:text-gray-400">
                    {displayMinute}'
                  </span>
                </div>
                <span className="text-4xl font-heading font-bold text-gray-900 dark:text-white tabular-nums">
                  {displayScore.away}
                </span>
              </div>

              <div className="flex items-center gap-3">
                <TeamLogo
                  team={awayFullTeam ?? makeTeamFallback(snapshot.away_team.name)}
                  className="w-10 h-10 rounded-lg flex items-center justify-center font-heading font-bold text-sm overflow-hidden"
                  imageClassName="h-8 w-8 object-contain drop-shadow"
                  style={{
                    backgroundColor: `${awayTeamColor}30`,
                    borderColor: awayTeamColor,
                    borderWidth: 2,
                  }}
                />
                <div className="text-left">
                  <p className="font-heading font-bold text-sm uppercase tracking-wider text-gray-800 dark:text-gray-200">
                    {snapshot.away_team.name}
                  </p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {snapshot.away_team.formation}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center gap-2">
              <Clock className="w-4 h-4 text-gray-500 dark:text-gray-400" />
              <span className="text-sm font-heading text-gray-500 dark:text-gray-400 tabular-nums w-8">
                {displayMinute}'
              </span>
            </div>
          </div>

          {/* Possession bar */}
          <div className="mt-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="font-heading font-bold text-primary-400 w-12 text-right">
                {snapshot.home_possession_pct.toFixed(0)}%
              </span>
              <div className="flex-1 h-1.5 bg-gray-300 dark:bg-navy-700 rounded-full overflow-hidden flex transition-colors duration-300">
                <div
                  className="h-full bg-primary-500 transition-all duration-500"
                  style={{ width: `${snapshot.home_possession_pct}%` }}
                />
                <div
                  className="h-full bg-indigo-500 transition-all duration-500"
                  style={{ width: `${snapshot.away_possession_pct}%` }}
                />
              </div>
              <span className="font-heading font-bold text-indigo-400 w-12">
                {snapshot.away_possession_pct.toFixed(0)}%
              </span>
            </div>
          </div>
        </>
      }
    >
      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel: Event Feed + Stats */}
        <div className="flex-1 flex flex-col">
          <div className="flex bg-white dark:bg-navy-800 border-b border-gray-200 dark:border-navy-700 transition-colors duration-300">
            {[
              {
                id: "events" as ActivePanel,
                label: t("match.events"),
                icon: <MessageSquare className="w-4 h-4" />,
              },
              {
                id: "pitch" as ActivePanel,
                label: t("match.pitch", "Pitch"),
                icon: <MapIcon className="w-4 h-4" />,
              },
              {
                id: "stats" as ActivePanel,
                label: t("match.stats"),
                icon: <BarChart3 className="w-4 h-4" />,
              },
              {
                id: "lineups" as ActivePanel,
                label: t("match.lineups"),
                icon: <Users className="w-4 h-4" />,
              },
            ].map((tab) => (
              <button
                type="button"
                key={tab.id}
                onClick={() => setActivePanel(tab.id)}
                className={`flex items-center gap-2 px-5 py-3 font-heading font-bold text-xs uppercase tracking-wider transition-colors border-b-2 ${
                  activePanel === tab.id
                    ? "text-primary-500 dark:text-primary-400 border-primary-500 bg-primary-50 dark:bg-navy-700/50"
                    : "text-gray-500 dark:text-gray-400 border-transparent hover:text-gray-700 dark:hover:text-gray-300"
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {(activePanel === "events" || activePanel === "pitch") && (
            <fieldset className="flex flex-wrap items-center gap-2 border-b border-gray-200 bg-white px-4 py-2 transition-colors duration-300 dark:border-navy-700 dark:bg-navy-800">
              <legend className="sr-only">{t("match.highlightMode", "How much to show")}</legend>
              {HIGHLIGHT_MODES.map((mode) => (
                <button
                  type="button"
                  key={mode}
                  onClick={() => setHighlightMode(mode)}
                  aria-pressed={highlightMode === mode}
                  className={`rounded-full px-3 py-1 font-heading text-xs font-bold uppercase tracking-wider transition-colors ${
                    highlightMode === mode
                      ? "bg-primary-500 text-white"
                      : "bg-gray-200 text-gray-600 hover:bg-gray-300 dark:bg-navy-700 dark:text-gray-300 dark:hover:bg-navy-600"
                  }`}
                >
                  {t(`match.highlightModes.${mode}`)}
                </button>
              ))}
            </fieldset>
          )}

          <div className="flex-1 overflow-auto p-4">
            {activePanel === "events" && (
              <EventFeed
                events={feedEvents}
                snapshot={snapshot}
                feedRef={eventFeedRef}
                playerJerseyMap={playerJerseyMap}
              />
            )}
            {activePanel === "pitch" && (
              <PitchView
                minute={pitchMinute}
                isHighlight={highlightMode !== "full"}
                playbackMs={
                  speed === "slow"
                    ? 18000
                    : speed === "fast"
                      ? 4000
                      : speed === "instant"
                        ? 1200
                        : 10000
                }
                paused={!isRunning || speed === "paused" || showSubPanel}
                snapshot={snapshot}
                playerJerseyMap={playerJerseyMap}
                onPlaybackStart={startPitch}
                onPlaybackComplete={finishPitch}
                onCursorChange={movePitch}
                homeColor={homeTeamColor}
                awayColor={awayTeamColor}
              />
            )}
            {activePanel === "stats" && <MatchStats snapshot={snapshot} />}
            {activePanel === "lineups" && <Lineups snapshot={snapshot} />}
          </div>
        </div>

        {/* Right Panel: Controls */}
        <aside className="w-72 bg-white dark:bg-navy-800 border-l border-gray-200 dark:border-navy-700 flex flex-col transition-colors duration-300">
          {/* Speed Controls */}
          <div className="p-4 border-b border-gray-200 dark:border-navy-700">
            <h3 className="text-xs font-heading font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-3">
              {t("match.simSpeed")}
            </h3>
            <div className="flex gap-1">
              {[
                {
                  id: "paused" as SimSpeed,
                  icon: <Pause className="w-4 h-4" />,
                  label: t("match.pause"),
                },
                {
                  id: "slow" as SimSpeed,
                  icon: <Play className="w-4 h-4" />,
                  label: t("match.slow"),
                },
                {
                  id: "normal" as SimSpeed,
                  icon: <Play className="w-4 h-4" />,
                  label: t("match.normal"),
                },
                {
                  id: "fast" as SimSpeed,
                  icon: <FastForward className="w-4 h-4" />,
                  label: t("match.fast"),
                },
                {
                  id: "instant" as SimSpeed,
                  icon: <SkipForward className="w-4 h-4" />,
                  label: t("match.max"),
                },
              ].map((s) => (
                <button
                  type="button"
                  key={s.id}
                  onClick={() => {
                    setSpeed(s.id);
                    setIsRunning(s.id !== "paused");
                    if (isPersistableSpeed(s.id)) {
                      onPreferredSpeedChange?.(s.id);
                    }
                  }}
                  className={`flex-1 flex flex-col items-center gap-1 py-2 rounded-lg text-xs font-heading uppercase tracking-wider transition-all ${
                    speed === s.id
                      ? "bg-primary-500/20 text-primary-500 dark:text-primary-400 ring-1 ring-primary-500/50"
                      : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-navy-700"
                  }`}
                >
                  {s.icon}
                  <span className="text-[10px]">{s.label}</span>
                </button>
              ))}
            </div>
            {speed === "paused" && (
              <button
                type="button"
                disabled={pendingPhase !== null}
                onClick={() => stepMatch(1)}
                className="w-full mt-2 flex items-center justify-center gap-2 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-navy-700 dark:hover:bg-navy-600 rounded-lg text-sm font-heading uppercase tracking-wider text-gray-700 dark:text-gray-300 transition-colors"
              >
                <ChevronRight className="w-4 h-4" />
                {t("match.step1Min")}
              </button>
            )}
          </div>

          {/* User Controls */}
          {!isSpectator && userSide && (
            <div className="p-4 border-b border-gray-200 dark:border-navy-700 flex flex-col gap-2">
              <h3 className="text-xs font-heading font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-1">
                {t("match.teamControls")}
              </h3>
              <button
                type="button"
                onClick={() => setShowSubPanel(!showSubPanel)}
                className="flex items-center gap-2 px-3 py-2 bg-gray-200 hover:bg-gray-300 dark:bg-navy-700 dark:hover:bg-navy-600 rounded-lg text-sm font-heading uppercase tracking-wider text-gray-700 dark:text-gray-300 transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {t("match.subs")} (
                {userSide === "Home" ? snapshot.home_subs_made : snapshot.away_subs_made}/
                {snapshot.max_subs})
              </button>
              <div>
                <p className="text-[10px] font-heading uppercase tracking-widest text-gray-600 dark:text-gray-500 mb-1">
                  {t("match.formation")}
                </p>
                <div className="flex flex-wrap gap-1">
                  {FORMATIONS.map((f) => {
                    const cur =
                      userSide === "Home"
                        ? snapshot.home_team.formation
                        : snapshot.away_team.formation;
                    return (
                      <button
                        type="button"
                        key={f}
                        onClick={() => handleFormationChange(f)}
                        className={`px-2 py-1 rounded text-xs font-heading transition-colors ${cur === f ? "bg-primary-500/20 text-primary-500 dark:text-primary-400 ring-1 ring-primary-500/50" : "bg-gray-100 text-gray-600 hover:text-gray-900 dark:bg-navy-700 dark:text-gray-400 dark:hover:text-gray-300"}`}
                      >
                        {f}
                      </button>
                    );
                  })}
                </div>
              </div>
              <div>
                <p className="text-[10px] font-heading uppercase tracking-widest text-gray-600 dark:text-gray-500 mb-1">
                  {t("match.playStyle")}
                </p>
                <div className="flex flex-wrap gap-1">
                  {[
                    { id: "Balanced", icon: <Target className="w-3 h-3" /> },
                    { id: "Attacking", icon: <Zap className="w-3 h-3" /> },
                    { id: "Defensive", icon: <Shield className="w-3 h-3" /> },
                    { id: "Possession", icon: <RefreshCw className="w-3 h-3" /> },
                    { id: "Counter", icon: <Crosshair className="w-3 h-3" /> },
                    { id: "HighPress", icon: <Flag className="w-3 h-3" /> },
                  ].map((s) => {
                    const cur =
                      userSide === "Home"
                        ? snapshot.home_team.play_style
                        : snapshot.away_team.play_style;
                    return (
                      <button
                        type="button"
                        key={s.id}
                        onClick={() => handlePlayStyleChange(s.id)}
                        className={`flex items-center gap-1 px-2 py-1 rounded text-xs font-heading transition-colors ${cur === s.id ? "bg-primary-500/20 text-primary-500 dark:text-primary-400 ring-1 ring-primary-500/50" : "bg-gray-100 text-gray-600 hover:text-gray-900 dark:bg-navy-700 dark:text-gray-400 dark:hover:text-gray-300"}`}
                      >
                        {s.icon}
                        {t(`common.playStyles.${s.id}`, s.id)}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}

          {/* Key Events sidebar */}
          <div className="p-4 flex-1 overflow-auto">
            <h3 className="text-xs font-heading font-bold uppercase tracking-widest text-gray-500 dark:text-gray-400 mb-3">
              {t("match.keyEvents")}
            </h3>
            <div className="flex flex-col gap-1.5">
              {visibleImportantEvents
                .filter((e) =>
                  [
                    "Goal",
                    "PenaltyGoal",
                    "YellowCard",
                    "RedCard",
                    "SecondYellow",
                    "Substitution",
                    "PenaltyMiss",
                    "Injury",
                  ].includes(e.event_type),
                )
                .slice(-12)
                .reverse()
                .map((evt, i) => {
                  const display = getEventDisplay(evt);
                  return (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="text-gray-600 dark:text-gray-500 tabular-nums w-6 text-right font-heading">
                        {evt.minute}'
                      </span>
                      <span>{display.icon}</span>
                      <span className={`${display.color} font-medium truncate`}>
                        {getPlayerName(snapshot, evt.player_id)}
                      </span>
                      <Badge variant={evt.side === "Home" ? "primary" : "accent"} size="sm">
                        {evt.side === "Home"
                          ? snapshot.home_team.name.substring(0, 3)
                          : snapshot.away_team.name.substring(0, 3)}
                      </Badge>
                    </div>
                  );
                })}
              {visibleImportantEvents.length === 0 && (
                <p className="text-gray-600 dark:text-gray-500 text-xs">{t("match.noEventsYet")}</p>
              )}
            </div>
          </div>
        </aside>
      </div>

      {/* Substitution Modal */}
      {showSubPanel && userSide && (
        <SubPanel
          snapshot={snapshot}
          side={userSide}
          onSubstitute={handleSubstitution}
          onFormationChange={handleFormationChange}
          onPlayStyleChange={handlePlayStyleChange}
          onClose={() => setShowSubPanel(false)}
        />
      )}
    </MatchScreenLayout>
  );
}
