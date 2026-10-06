//! Frame-by-frame match data for a 3D (or 2D) match viewer.
//!
//! The match engine does not move players around a pitch: it resolves a few
//! actions a minute across five zones and records them as [`MatchEvent`]s. A
//! viewer needs something very different — where the ball and all 22 players
//! are, many times a second, plus which way each player faces and what they are
//! doing.
//!
//! This module bridges the two. It takes the events of one match minute and
//! plays them out as [`TICK_RATE_HZ`] snapshots a second: the ball travels from
//! one event to the next (rolling along the ground, or flying on a real
//! gravity arc for crosses, clearances and goal kicks), the players involved
//! run to where their event happens, and everyone else holds a team shape that
//! follows the ball.
//!
//! Two properties matter and are covered by the tests:
//!
//! - **It never changes a match.** No random numbers are drawn and nothing is
//!   written back, so results, statistics and commentary are untouched.
//! - **It is repeatable.** The same minute always produces the same frames, so
//!   a replay needs no recording — ask for the minute again.
//!
//! The movement is a reconstruction that fits the events, not a record of
//! simulated player tracking.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::event::{EventType, MatchEvent, PITCH_LENGTH, PITCH_WIDTH};
use crate::types::{Position, Side, TeamData};

/// Snapshots per simulated second.
pub const TICK_RATE_HZ: u32 = 10;
/// Snapshots in one match minute.
pub const TICKS_PER_MINUTE: usize = 60 * TICK_RATE_HZ as usize;

const DT: f32 = 1.0 / TICK_RATE_HZ as f32;
const GRAVITY: f32 = 9.81;
/// How fast a played ball travels along the ground, in metres a second.
const BALL_SPEED: f32 = 18.0;
/// Top running speed, in metres a second.
const SPRINT_SPEED: f32 = 7.5;
/// The most a player may cover to make it to their own event on time.
const MAX_SPEED: f32 = 11.0;
/// How fast a player can turn, in radians a second.
const TURN_RATE: f32 = 8.0;
/// How long before an event its player starts moving towards it, in seconds.
const LEAD_TIME: f32 = 4.0;
/// How long an action animation (kick, tackle, header, dive) lasts, in seconds.
const ACTION_TIME: f32 = 0.6;
const GOAL_CENTRE_Y: f32 = PITCH_WIDTH / 2.0;
const GOAL_HALF_WIDTH: f32 = 3.66;

/// What a player model should be doing on a given tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum PlayerAnimState {
    Idle,
    Walk,
    Sprint,
    KickShort,
    KickPower,
    HeaderJump,
    SlideTackle,
    KeeperDiveLeft,
    KeeperDiveRight,
}

/// One player in a [`MinuteFrames`] roster. The player at index `i` here is the
/// player at index `i` of every frame's `players`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FramePlayer {
    pub player_id: String,
    pub side: Side,
    pub position: Position,
}

/// Where one player is on one tick.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PlayerFrame {
    /// Metres from the home goal line (0) towards the away goal line (105).
    pub x: f32,
    /// Metres from the top touchline (0) to the bottom one (68).
    pub y: f32,
    /// Height of the player's feet above the pitch, in metres.
    pub z: f32,
    /// Direction the player faces, in radians: 0 looks at the away goal, and
    /// the angle grows towards the bottom touchline (`atan2(dy, dx)`).
    pub facing: f32,
    pub anim: PlayerAnimState,
}

/// Where the ball is on one tick.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct BallFrame {
    pub x: f32,
    pub y: f32,
    /// Height above the pitch, in metres. 0 is on the grass.
    pub z: f32,
}

/// The whole pitch at one instant.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MatchFrame {
    /// Tick within the minute, `0..TICKS_PER_MINUTE`.
    pub tick: u16,
    pub ball: BallFrame,
    /// One entry per roster player, in roster order.
    pub players: Vec<PlayerFrame>,
}

/// Every snapshot of one match minute.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MinuteFrames {
    pub minute: u8,
    pub tick_rate_hz: u32,
    pub pitch_length: f32,
    pub pitch_width: f32,
    pub players: Vec<FramePlayer>,
    pub frames: Vec<MatchFrame>,
}

impl MinuteFrames {
    /// Keep every `stride`th snapshot. A 3D viewer wants all ten a second; a
    /// simple pitch view that glides between snapshots needs far fewer, and
    /// sending fewer keeps a fast-forwarded match light.
    pub fn thinned(mut self, stride: u8) -> Self {
        let stride = usize::from(stride.max(1));
        if stride > 1 {
            self.frames = self.frames.into_iter().step_by(stride).collect();
        }
        self
    }
}

// ---------------------------------------------------------------------------
// Ball
// ---------------------------------------------------------------------------

/// A point the ball must be at, at a given time.
#[derive(Debug, Clone, Copy)]
struct BallKey {
    t: f32,
    x: f32,
    y: f32,
    /// Height the ball has on arrival here (a shot over the bar, a goal).
    z: f32,
    /// Whether the ball leaves this point through the air.
    lofted: bool,
}

/// The goal line a side attacks.
fn attacking_goal_x(side: Side) -> f32 {
    match side {
        Side::Home => PITCH_LENGTH,
        Side::Away => 0.0,
    }
}

/// Events the ball is actually at. Cards, substitutions and the like are placed
/// on the pitch for the feed's benefit but the ball does not travel to them.
fn moves_ball(event_type: &EventType) -> bool {
    matches!(
        event_type,
        EventType::KickOff
            | EventType::SecondHalfStart
            | EventType::PassCompleted
            | EventType::PassIntercepted
            | EventType::Interception
            | EventType::Dribble
            | EventType::DribbleTackled
            | EventType::Tackle
            | EventType::Cross
            | EventType::Clearance
            | EventType::ShotOnTarget
            | EventType::ShotOffTarget
            | EventType::ShotBlocked
            | EventType::ShotSaved
            | EventType::Goal
            | EventType::PenaltyGoal
            | EventType::PenaltyMiss
            | EventType::ShootoutGoal
            | EventType::ShootoutMiss
            | EventType::Foul
            | EventType::Corner
            | EventType::FreeKick
            | EventType::GoalKick
    )
}

/// Events after which the ball leaves through the air.
fn is_lofted(event_type: &EventType) -> bool {
    matches!(
        event_type,
        EventType::Cross
            | EventType::Clearance
            | EventType::Corner
            | EventType::FreeKick
            | EventType::GoalKick
    )
}

fn is_shot(event_type: &EventType) -> bool {
    matches!(
        event_type,
        EventType::ShotOnTarget
            | EventType::ShotOffTarget
            | EventType::ShotBlocked
            | EventType::ShotSaved
            | EventType::Goal
            | EventType::PenaltyGoal
            | EventType::PenaltyMiss
            | EventType::ShootoutGoal
            | EventType::ShootoutMiss
    )
}

/// Where a shot ends up, and how high, shortly after it is struck.
fn shot_destination(event: &MatchEvent) -> (f32, f32, f32) {
    let goal_x = attacking_goal_x(event.side);
    // Which side of the goal: decided by where the shot came from, so it is stable.
    let near_top = event.y < GOAL_CENTRE_Y;
    let sign = if near_top { -1.0 } else { 1.0 };
    let towards_pitch = if goal_x > 0.0 { -1.0 } else { 1.0 };
    match event.event_type {
        // In the net, inside the post.
        EventType::Goal | EventType::PenaltyGoal | EventType::ShootoutGoal => {
            (goal_x, GOAL_CENTRE_Y + sign * 2.4, 0.9)
        }
        // Wide of the post and rising.
        EventType::ShotOffTarget | EventType::PenaltyMiss | EventType::ShootoutMiss => {
            (goal_x, GOAL_CENTRE_Y + sign * 5.5, 2.6)
        }
        // Charged down a few metres from where it was struck.
        EventType::ShotBlocked => {
            let dx = goal_x - event.x;
            let dy = GOAL_CENTRE_Y - event.y;
            let dist = (dx * dx + dy * dy).sqrt().max(0.01);
            (event.x + dx / dist * 3.0, event.y + dy / dist * 3.0, 0.4)
        }
        // Held by the keeper, just off the line.
        _ => (
            goal_x + towards_pitch * 1.5,
            GOAL_CENTRE_Y + sign * 1.8,
            0.8,
        ),
    }
}

fn ball_keys(events: &[&MatchEvent], ball_start: Option<(f32, f32)>) -> Vec<BallKey> {
    let mut keys: Vec<BallKey> = Vec::new();
    for event in events.iter().filter(|e| moves_ball(&e.event_type)) {
        let t = f32::from(event.second);
        keys.push(BallKey {
            t,
            x: event.x,
            y: event.y,
            z: 0.0,
            lofted: is_lofted(&event.event_type),
        });
        if is_shot(&event.event_type) {
            let (x, y, z) = shot_destination(event);
            // A shot struck right on the goal line must not carry off the pitch.
            let (x, y) = clamp_to_pitch(x, y);
            keys.push(BallKey {
                t: t + 0.8,
                x,
                y,
                z,
                lofted: false,
            });
        }
    }
    keys.sort_by(|a, b| a.t.total_cmp(&b.t));

    // Where the ball waits before the first event of the minute.
    let (start_x, start_y) = ball_start
        .or_else(|| keys.first().map(|k| (k.x, k.y)))
        .unwrap_or((PITCH_LENGTH / 2.0, PITCH_WIDTH / 2.0));
    let needs_start = keys.first().is_none_or(|k| k.t > 0.0);
    if needs_start {
        keys.insert(
            0,
            BallKey {
                t: 0.0,
                x: start_x,
                y: start_y,
                z: 0.0,
                lofted: false,
            },
        );
    }
    keys
}

/// The ball at time `t`. It waits at each key point and sets off just in time
/// to reach the next one as that event happens.
fn ball_at(keys: &[BallKey], t: f32) -> BallFrame {
    let Some(last) = keys.last() else {
        return BallFrame {
            x: PITCH_LENGTH / 2.0,
            y: PITCH_WIDTH / 2.0,
            z: 0.0,
        };
    };
    if t >= last.t {
        // A shot's destination has height on arrival; let it drop to the grass.
        let fallen = (last.z - 0.5 * GRAVITY * (t - last.t).powi(2)).max(0.0);
        return BallFrame {
            x: last.x,
            y: last.y,
            z: fallen,
        };
    }
    let next_index = keys.iter().position(|k| k.t > t).unwrap_or(keys.len() - 1);
    if next_index == 0 {
        return BallFrame {
            x: keys[0].x,
            y: keys[0].y,
            z: 0.0,
        };
    }
    let from = keys[next_index - 1];
    let to = keys[next_index];
    let gap = (to.t - from.t).max(DT);
    let distance = ((to.x - from.x).powi(2) + (to.y - from.y).powi(2)).sqrt();
    let wanted = if from.lofted {
        (distance / BALL_SPEED).clamp(0.8, 2.2)
    } else {
        (distance / BALL_SPEED).max(0.3)
    };
    let travel = wanted.min(gap);
    let depart = to.t - travel;
    if t <= depart {
        let resting = (from.z - 0.5 * GRAVITY * (t - from.t).powi(2)).max(0.0);
        return BallFrame {
            x: from.x,
            y: from.y,
            z: resting,
        };
    }
    let elapsed = t - depart;
    let progress = (elapsed / travel).clamp(0.0, 1.0);
    let x = from.x + (to.x - from.x) * progress;
    let y = from.y + (to.y - from.y) * progress;
    let z = if from.lofted {
        // Launched so that gravity brings it down exactly on arrival:
        // z(t) = v t - g t^2 / 2, with v = g * flight_time / 2.
        let launch = GRAVITY * travel / 2.0;
        (launch * elapsed - 0.5 * GRAVITY * elapsed * elapsed).max(0.0)
    } else {
        // Along the ground, rising only if it has to arrive with height.
        to.z * progress
    };
    BallFrame { x, y, z }
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

/// A moment a player has to be somewhere to do something.
#[derive(Debug, Clone, Copy)]
struct Engagement {
    t: f32,
    x: f32,
    y: f32,
    anim: Option<PlayerAnimState>,
}

struct Mover {
    side: Side,
    position: Position,
    /// Place among team-mates in the same line, and how many there are.
    slot: usize,
    slots: usize,
    engagements: Vec<Engagement>,
    x: f32,
    y: f32,
    facing: f32,
}

fn clamp_to_pitch(x: f32, y: f32) -> (f32, f32) {
    (x.clamp(0.0, PITCH_LENGTH), y.clamp(0.0, PITCH_WIDTH))
}

/// A player's place in the team shape, given where the ball is.
fn shape_position(mover: &Mover, ball: &BallFrame) -> (f32, f32) {
    // Work as if attacking towards x = 105, then mirror for the away side.
    let (ball_along, ball_across) = match mover.side {
        Side::Home => (ball.x, ball.y),
        Side::Away => (PITCH_LENGTH - ball.x, PITCH_WIDTH - ball.y),
    };
    let (along, across) = match mover.position {
        Position::Goalkeeper => (
            5.0 + ball_along * 0.08,
            GOAL_CENTRE_Y + (ball_across - GOAL_CENTRE_Y) * 0.12,
        ),
        outfield => {
            let depth = match outfield {
                Position::Defender => 24.0,
                Position::Midfielder => 44.0,
                _ => 62.0,
            };
            let spread = PITCH_WIDTH * (mover.slot as f32 + 1.0) / (mover.slots as f32 + 1.0);
            (
                (depth + (ball_along - PITCH_LENGTH / 2.0) * 0.45).clamp(10.0, 97.0),
                (spread + (ball_across - GOAL_CENTRE_Y) * 0.2).clamp(3.0, PITCH_WIDTH - 3.0),
            )
        }
    };
    match mover.side {
        Side::Home => (along, across),
        Side::Away => (PITCH_LENGTH - along, PITCH_WIDTH - across),
    }
}

fn action_for(event: &MatchEvent, previous: Option<&EventType>) -> Option<PlayerAnimState> {
    match event.event_type {
        EventType::PassCompleted | EventType::PassIntercepted => Some(PlayerAnimState::KickShort),
        // A clearance straight after a cross is won in the air.
        EventType::Clearance if previous == Some(&EventType::Cross) => {
            Some(PlayerAnimState::HeaderJump)
        }
        EventType::Cross
        | EventType::Clearance
        | EventType::ShotOnTarget
        | EventType::ShotOffTarget
        | EventType::ShotBlocked
        | EventType::ShotSaved
        | EventType::Goal
        | EventType::PenaltyGoal
        | EventType::PenaltyMiss
        | EventType::ShootoutGoal
        | EventType::ShootoutMiss => Some(PlayerAnimState::KickPower),
        EventType::Tackle | EventType::Foul => Some(PlayerAnimState::SlideTackle),
        _ => None,
    }
}

/// Which way the keeper dives, from the keeper's own point of view.
fn dive_direction(keeper_side: Side, ball_y: f32) -> PlayerAnimState {
    // The home keeper faces +x, so their left hand is towards y = 0.
    let towards_top = ball_y < GOAL_CENTRE_Y;
    let left = match keeper_side {
        Side::Home => towards_top,
        Side::Away => !towards_top,
    };
    if left {
        PlayerAnimState::KeeperDiveLeft
    } else {
        PlayerAnimState::KeeperDiveRight
    }
}

fn shortest_turn(from: f32, to: f32) -> f32 {
    let mut diff = (to - from) % std::f32::consts::TAU;
    if diff > std::f32::consts::PI {
        diff -= std::f32::consts::TAU;
    } else if diff < -std::f32::consts::PI {
        diff += std::f32::consts::TAU;
    }
    diff
}

fn wrap_angle(angle: f32) -> f32 {
    shortest_turn(0.0, angle)
}

fn round2(value: f32) -> f32 {
    (value * 100.0).round() / 100.0
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/// Play out one match minute as [`TICKS_PER_MINUTE`] snapshots.
///
/// `events` may be the whole match log; only those of `minute` are used, and
/// they must already carry their seconds (see `event::stamp_seconds`).
/// `ball_start` is where the ball was left at the end of the previous minute,
/// if known, so consecutive minutes join up.
pub fn build_minute_frames(
    minute: u8,
    events: &[MatchEvent],
    home: &TeamData,
    away: &TeamData,
    sent_off: &HashSet<String>,
    ball_start: Option<(f32, f32)>,
) -> MinuteFrames {
    let minute_events: Vec<&MatchEvent> = events.iter().filter(|e| e.minute == minute).collect();
    let keys = ball_keys(&minute_events, ball_start);

    // Roster: everyone on the pitch, home first.
    let mut roster: Vec<FramePlayer> = Vec::new();
    let mut movers: Vec<Mover> = Vec::new();
    for (side, team) in [(Side::Home, home), (Side::Away, away)] {
        let on_pitch: Vec<_> = team
            .players
            .iter()
            .filter(|p| !sent_off.contains(&p.id))
            .collect();
        for player in &on_pitch {
            let line: Vec<_> = on_pitch
                .iter()
                .filter(|p| p.position == player.position)
                .collect();
            let slot = line.iter().position(|p| p.id == player.id).unwrap_or(0);
            roster.push(FramePlayer {
                player_id: player.id.clone(),
                side,
                position: player.position,
            });
            movers.push(Mover {
                side,
                position: player.position,
                slot,
                slots: line.len().max(1),
                engagements: Vec::new(),
                x: 0.0,
                y: 0.0,
                facing: match side {
                    Side::Home => 0.0,
                    Side::Away => std::f32::consts::PI,
                },
            });
        }
    }
    let index_of = |player_id: &str| roster.iter().position(|p| p.player_id == player_id);

    // Who has to be where, and when.
    let mut previous_type: Option<&EventType> = None;
    for event in &minute_events {
        let t = f32::from(event.second);
        if moves_ball(&event.event_type) {
            if let Some(index) = event.player_id.as_deref().and_then(index_of) {
                movers[index].engagements.push(Engagement {
                    t,
                    x: event.x,
                    y: event.y,
                    anim: action_for(event, previous_type),
                });
            }
            // The other player in the duel stands a stride away, goal side.
            if let Some(index) = event.secondary_player_id.as_deref().and_then(index_of) {
                let offset = if attacking_goal_x(movers[index].side) > 0.0 {
                    -1.2
                } else {
                    1.2
                };
                let (x, y) = clamp_to_pitch(event.x + offset, event.y);
                movers[index].engagements.push(Engagement {
                    t,
                    x,
                    y,
                    anim: None,
                });
            }
            // A shot on goal brings the defending keeper across.
            if matches!(
                event.event_type,
                EventType::ShotSaved
                    | EventType::ShotOnTarget
                    | EventType::Goal
                    | EventType::PenaltyGoal
                    | EventType::ShootoutGoal
            ) {
                let keeper_side = event.side.opposite();
                let keeper = roster
                    .iter()
                    .position(|p| p.side == keeper_side && p.position == Position::Goalkeeper);
                if let Some(index) = keeper {
                    let (shot_x, shot_y, _) = shot_destination(event);
                    let line_x = attacking_goal_x(event.side);
                    let towards_pitch = if line_x > 0.0 { -1.0 } else { 1.0 };
                    let saved = event.event_type == EventType::ShotSaved;
                    movers[index].engagements.push(Engagement {
                        t: t + 0.8,
                        x: if saved {
                            shot_x
                        } else {
                            line_x + towards_pitch * 1.0
                        },
                        y: shot_y.clamp(
                            GOAL_CENTRE_Y - GOAL_HALF_WIDTH,
                            GOAL_CENTRE_Y + GOAL_HALF_WIDTH,
                        ),
                        anim: Some(dive_direction(keeper_side, shot_y)),
                    });
                }
            }
        }
        previous_type = Some(&event.event_type);
    }
    for mover in &mut movers {
        mover.engagements.sort_by(|a, b| a.t.total_cmp(&b.t));
    }

    // Everyone starts in shape around the ball.
    let first_ball = ball_at(&keys, 0.0);
    for mover in &mut movers {
        let (x, y) = shape_position(mover, &first_ball);
        mover.x = x;
        mover.y = y;
    }

    let mut frames = Vec::with_capacity(TICKS_PER_MINUTE);
    for tick in 0..TICKS_PER_MINUTE {
        let t = tick as f32 * DT;
        let ball = ball_at(&keys, t);
        let mut players = Vec::with_capacity(movers.len());

        for mover in &mut movers {
            // The engagement this player is heading to or has just carried out.
            let current = mover
                .engagements
                .iter()
                .find(|e| t >= e.t - LEAD_TIME && t < e.t + ACTION_TIME + 0.4)
                .copied();

            let (target_x, target_y, speed_limit) = match current {
                Some(engagement) if t < engagement.t => {
                    // Arrive exactly on time: go as fast as the distance needs.
                    let remaining = (engagement.t - t).max(DT);
                    let distance = ((engagement.x - mover.x).powi(2)
                        + (engagement.y - mover.y).powi(2))
                    .sqrt();
                    (
                        engagement.x,
                        engagement.y,
                        (distance / remaining).min(MAX_SPEED),
                    )
                }
                Some(engagement) => (engagement.x, engagement.y, MAX_SPEED),
                None => {
                    let (x, y) = shape_position(mover, &ball);
                    (x, y, SPRINT_SPEED)
                }
            };

            let dx = target_x - mover.x;
            let dy = target_y - mover.y;
            let distance = (dx * dx + dy * dy).sqrt();
            let step = (speed_limit * DT).min(distance);
            let (vx, vy) = if distance > 1e-4 && tick > 0 {
                (dx / distance * step, dy / distance * step)
            } else {
                (0.0, 0.0)
            };
            mover.x += vx;
            mover.y += vy;
            let speed = (vx * vx + vy * vy).sqrt() / DT;

            // Face the way you run; when standing, watch the ball. Turning takes time.
            let wanted = if speed > 0.5 {
                vy.atan2(vx)
            } else {
                (ball.y - mover.y).atan2(ball.x - mover.x)
            };
            let turn = shortest_turn(mover.facing, wanted).clamp(-TURN_RATE * DT, TURN_RATE * DT);
            mover.facing = wrap_angle(mover.facing + turn);

            // An action animation, with its little bit of height, wins over running.
            let acting = current.and_then(|e| {
                let since = t - e.t;
                (0.0..ACTION_TIME)
                    .contains(&since)
                    .then_some(e.anim)
                    .flatten()
                    .map(|anim| (anim, since))
            });
            let (anim, z) = match acting {
                Some((PlayerAnimState::HeaderJump, since)) => {
                    // A standing jump: up at 3 m/s, back down under gravity.
                    let height = 3.0 * since - 0.5 * GRAVITY * since * since;
                    (PlayerAnimState::HeaderJump, height.max(0.0))
                }
                Some((
                    anim @ (PlayerAnimState::KeeperDiveLeft | PlayerAnimState::KeeperDiveRight),
                    since,
                )) => {
                    let height = 2.6 * since - 0.5 * GRAVITY * since * since;
                    (anim, height.max(0.0))
                }
                Some((anim, _)) => (anim, 0.0),
                None if speed < 0.4 => (PlayerAnimState::Idle, 0.0),
                None if speed < 4.0 => (PlayerAnimState::Walk, 0.0),
                None => (PlayerAnimState::Sprint, 0.0),
            };

            players.push(PlayerFrame {
                x: round2(mover.x),
                y: round2(mover.y),
                z: round2(z),
                facing: round2(mover.facing),
                anim,
            });
        }

        frames.push(MatchFrame {
            tick: tick as u16,
            ball: BallFrame {
                x: round2(ball.x),
                y: round2(ball.y),
                z: round2(ball.z),
            },
            players,
        });
    }

    MinuteFrames {
        minute,
        tick_rate_hz: TICK_RATE_HZ,
        pitch_length: PITCH_LENGTH,
        pitch_width: PITCH_WIDTH,
        players: roster,
        frames,
    }
}

/// Where the ball is left at the end of `minute`, for joining up the next one.
pub fn ball_end_of_minute(minute: u8, events: &[MatchEvent]) -> Option<(f32, f32)> {
    let minute_events: Vec<&MatchEvent> = events.iter().filter(|e| e.minute == minute).collect();
    let keys = ball_keys(&minute_events, None);
    if minute_events.iter().any(|e| moves_ball(&e.event_type)) {
        keys.last().map(|k| clamp_to_pitch(k.x, k.y))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::stamp_seconds;
    use crate::types::{PlayStyle, PlayerData};

    fn player(id: &str, position: Position) -> PlayerData {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "name": id,
            "position": position,
            "condition": 100,
            "pace": 60, "stamina": 60, "strength": 60, "agility": 60,
            "passing": 60, "shooting": 60, "tackling": 60, "dribbling": 60,
            "defending": 60, "positioning": 60, "vision": 60, "decisions": 60,
            "composure": 60, "aggression": 60, "teamwork": 60, "leadership": 60,
            "handling": 60, "reflexes": 60, "aerial": 60,
            "traits": []
        }))
        .expect("test player")
    }

    fn team(prefix: &str) -> TeamData {
        let mut players = vec![player(&format!("{prefix}-gk"), Position::Goalkeeper)];
        for i in 0..4 {
            players.push(player(&format!("{prefix}-d{i}"), Position::Defender));
        }
        for i in 0..4 {
            players.push(player(&format!("{prefix}-m{i}"), Position::Midfielder));
        }
        for i in 0..2 {
            players.push(player(&format!("{prefix}-f{i}"), Position::Forward));
        }
        TeamData {
            id: prefix.to_string(),
            name: prefix.to_string(),
            formation: "4-4-2".to_string(),
            play_style: PlayStyle::Balanced,
            players,
            tactics: Default::default(),
        }
    }

    fn at(mut event: MatchEvent, x: f32, y: f32) -> MatchEvent {
        event.x = x;
        event.y = y;
        event
    }

    /// A pass in midfield, a dribble and cross from the wing, then a header clear.
    fn sample_minute() -> Vec<MatchEvent> {
        let mut events = vec![
            at(
                MatchEvent::new(
                    7,
                    EventType::PassCompleted,
                    Side::Home,
                    crate::types::Zone::Midfield,
                )
                .with_player("h-m1"),
                50.0,
                30.0,
            ),
            at(
                MatchEvent::new(
                    7,
                    EventType::Dribble,
                    Side::Home,
                    crate::types::Zone::AwayDefense,
                )
                .with_player("h-m3"),
                75.0,
                58.0,
            ),
            at(
                MatchEvent::new(
                    7,
                    EventType::Cross,
                    Side::Home,
                    crate::types::Zone::AwayDefense,
                )
                .with_player("h-m3"),
                84.0,
                61.0,
            ),
            at(
                MatchEvent::new(
                    7,
                    EventType::Clearance,
                    Side::Away,
                    crate::types::Zone::AwayBox,
                )
                .with_player("a-d1"),
                96.0,
                36.0,
            ),
        ];
        stamp_seconds(&mut events);
        events
    }

    fn build(events: &[MatchEvent]) -> MinuteFrames {
        build_minute_frames(7, events, &team("h"), &team("a"), &HashSet::new(), None)
    }

    fn index(frames: &MinuteFrames, id: &str) -> usize {
        frames
            .players
            .iter()
            .position(|p| p.player_id == id)
            .expect("player in roster")
    }

    fn tick_of(event: &MatchEvent) -> usize {
        usize::from(event.second) * TICK_RATE_HZ as usize
    }

    #[test]
    fn a_minute_is_600_snapshots_of_22_players() {
        let frames = build(&sample_minute());
        assert_eq!(frames.frames.len(), TICKS_PER_MINUTE);
        assert_eq!(frames.players.len(), 22);
        assert!(frames.frames.iter().all(|f| f.players.len() == 22));
        assert_eq!(frames.tick_rate_hz, 10);
    }

    #[test]
    fn the_same_minute_always_gives_the_same_frames() {
        let events = sample_minute();
        assert_eq!(build(&events), build(&events));
    }

    #[test]
    fn the_ball_is_at_each_event_when_it_happens() {
        let events = sample_minute();
        let frames = build(&events);
        for event in &events {
            let ball = frames.frames[tick_of(event)].ball;
            assert!((ball.x - event.x).abs() < 0.05, "{:?} x", event.event_type);
            assert!((ball.y - event.y).abs() < 0.05, "{:?} y", event.event_type);
        }
    }

    #[test]
    fn the_player_is_at_their_event_and_plays_the_right_animation() {
        let events = sample_minute();
        let frames = build(&events);
        let expected = [
            ("h-m1", PlayerAnimState::KickShort),
            ("h-m3", PlayerAnimState::Sprint),
            ("h-m3", PlayerAnimState::KickPower),
            ("a-d1", PlayerAnimState::HeaderJump),
        ];
        for (event, (id, anim)) in events.iter().zip(expected) {
            let frame = &frames.frames[tick_of(event) + 1];
            let who = frame.players[index(&frames, id)];
            assert!(
                (who.x - event.x).abs() < 0.2,
                "{id} x {} vs {}",
                who.x,
                event.x
            );
            assert!(
                (who.y - event.y).abs() < 0.2,
                "{id} y {} vs {}",
                who.y,
                event.y
            );
            if anim != PlayerAnimState::Sprint {
                assert_eq!(who.anim, anim, "{id} at {:?}", event.event_type);
            }
        }
    }

    #[test]
    fn a_cross_flies_on_a_gravity_arc_and_a_pass_stays_on_the_grass() {
        let events = sample_minute();
        let frames = build(&events);
        let cross = tick_of(&events[2]);
        let clearance = tick_of(&events[3]);
        let peak = frames.frames[cross..=clearance]
            .iter()
            .map(|f| f.ball.z)
            .fold(0.0, f32::max);
        assert!(peak > 1.5, "cross peaked at {peak} m");
        assert!(peak < 8.0, "cross peaked at {peak} m");
        assert!(
            frames.frames[clearance].ball.z < 0.05,
            "ball lands for the header"
        );

        let pass = tick_of(&events[0]);
        let dribble = tick_of(&events[1]);
        assert!(
            frames.frames[pass..=dribble]
                .iter()
                .all(|f| f.ball.z == 0.0)
        );
    }

    #[test]
    fn a_header_leaves_the_ground_and_comes_back_down() {
        let events = sample_minute();
        let frames = build(&events);
        let who = index(&frames, "a-d1");
        let start = tick_of(&events[3]);
        let highest = frames.frames[start..start + 8]
            .iter()
            .map(|f| f.players[who].z)
            .fold(0.0, f32::max);
        assert!(highest > 0.2 && highest < 1.0, "jumped {highest} m");
        assert_eq!(frames.frames[start + 10].players[who].z, 0.0);
    }

    #[test]
    fn nobody_outruns_a_footballer_or_spins_on_the_spot() {
        let frames = build(&sample_minute());
        for pair in frames.frames.windows(2) {
            for (before, after) in pair[0].players.iter().zip(&pair[1].players) {
                let moved = ((after.x - before.x).powi(2) + (after.y - before.y).powi(2)).sqrt();
                assert!(moved / DT <= MAX_SPEED + 0.3, "moved at {} m/s", moved / DT);
                let turned = shortest_turn(before.facing, after.facing).abs();
                assert!(
                    turned <= TURN_RATE * DT + 0.02,
                    "turned {turned} rad in a tick"
                );
            }
        }
    }

    #[test]
    fn everyone_stays_on_the_pitch() {
        let frames = build(&sample_minute());
        for frame in &frames.frames {
            for who in &frame.players {
                assert!((0.0..=PITCH_LENGTH).contains(&who.x));
                assert!((0.0..=PITCH_WIDTH).contains(&who.y));
                assert!(who.z >= 0.0);
            }
            assert!(frame.ball.z >= 0.0);
        }
    }

    #[test]
    fn a_saved_shot_sends_the_keeper_diving_the_right_way() {
        let mut events = vec![at(
            MatchEvent::new(
                7,
                EventType::ShotSaved,
                Side::Home,
                crate::types::Zone::AwayBox,
            )
            .with_player("h-f0"),
            92.0,
            28.0,
        )];
        stamp_seconds(&mut events);
        let frames = build(&events);
        let keeper = index(&frames, "a-gk");
        let dive_tick = tick_of(&events[0]) + 9;
        // The shot came from the top half, so the ball goes to the top side of
        // the goal — the away keeper, facing the other way, dives to their right.
        assert_eq!(
            frames.frames[dive_tick].players[keeper].anim,
            PlayerAnimState::KeeperDiveRight
        );
    }

    #[test]
    fn a_sent_off_player_is_not_on_the_pitch() {
        let sent_off: HashSet<String> = ["h-m1".to_string()].into();
        let frames = build_minute_frames(7, &[], &team("h"), &team("a"), &sent_off, None);
        assert_eq!(frames.players.len(), 21);
        assert!(frames.players.iter().all(|p| p.player_id != "h-m1"));
    }

    #[test]
    fn a_quiet_minute_still_has_everyone_in_shape() {
        let frames = build_minute_frames(7, &[], &team("h"), &team("a"), &HashSet::new(), None);
        assert_eq!(frames.frames.len(), TICKS_PER_MINUTE);
        let home_keeper = frames.frames[0].players[index(&frames, "h-gk")];
        let away_keeper = frames.frames[0].players[index(&frames, "a-gk")];
        assert!(home_keeper.x < 15.0 && away_keeper.x > 90.0);
    }

    #[test]
    fn thinning_keeps_every_nth_snapshot_and_the_first_one() {
        let frames = build(&sample_minute()).thinned(5);
        assert_eq!(frames.frames.len(), TICKS_PER_MINUTE / 5);
        assert_eq!(frames.frames[0].tick, 0);
        assert_eq!(frames.frames[1].tick, 5);
        assert_eq!(
            build(&sample_minute()).thinned(0).frames.len(),
            TICKS_PER_MINUTE
        );
    }
}
