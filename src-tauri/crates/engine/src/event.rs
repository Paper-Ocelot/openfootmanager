use crate::types::{Side, Zone};
use serde::{Deserialize, Serialize};

/// A single event that occurred during the match.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchEvent {
    pub minute: u8,
    pub event_type: EventType,
    pub side: Side,
    pub zone: Zone,
    /// ID of the primary player involved (scorer, passer, fouler, etc.).
    pub player_id: Option<String>,
    /// ID of a secondary player (assist provider, fouled player, etc.).
    pub secondary_player_id: Option<String>,
    /// Optional engine-derived qualifier for richer commentary. `None` for
    /// events that carry no extra colour.
    #[serde(default)]
    pub detail: Option<EventDetail>,
    /// Second within `minute` (0-59). Filled in by [`stamp_seconds`] so the
    /// events of one minute read in order on a `mm:ss` feed.
    #[serde(default)]
    pub second: u8,
    /// Where on the pitch it happened, in metres along the pitch: 0 is the
    /// home goal line, [`PITCH_LENGTH`] the away goal line.
    #[serde(default = "default_x")]
    pub x: f32,
    /// Metres across the pitch: 0 is the top touchline, [`PITCH_WIDTH`] the
    /// bottom one, as seen with the home goal on the left.
    #[serde(default = "default_y")]
    pub y: f32,
}

/// Pitch dimensions in metres (the standard 105 x 68 pitch).
pub const PITCH_LENGTH: f32 = 105.0;
pub const PITCH_WIDTH: f32 = 68.0;

fn default_x() -> f32 {
    PITCH_LENGTH / 2.0
}

fn default_y() -> f32 {
    PITCH_WIDTH / 2.0
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventType {
    // --- Structural events ---
    KickOff,
    HalfTime,
    SecondHalfStart,
    FullTime,

    // --- Possession & passing ---
    PassCompleted,
    PassIntercepted,

    // --- Attacking ---
    Dribble,
    DribbleTackled,
    Cross,

    // --- Shooting ---
    ShotOnTarget,
    ShotOffTarget,
    ShotBlocked,
    ShotSaved,
    Goal,
    PenaltyAwarded,
    PenaltyGoal,
    PenaltyMiss,
    // Penalty-shootout kicks. Distinct from PenaltyGoal/PenaltyMiss so the
    // shootout never counts toward match goals or player stats.
    ShootoutGoal,
    ShootoutMiss,

    // --- Defending ---
    Tackle,
    Interception,
    Clearance,

    // --- Fouls & discipline ---
    Foul,
    YellowCard,
    RedCard,
    SecondYellow,

    // --- Set pieces ---
    Corner,
    FreeKick,

    // --- Other ---
    Injury,
    GoalKick,
    Substitution,
}

/// Truthful, engine-derived qualifiers used to colour commentary.
/// Every variant carries only values the engine already computes, so prose
/// built from it never claims something that was not simulated.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum EventDetail {
    Shot { danger: DangerBand },
    Save { quality: SaveQuality },
    Foul { severity: FoulSeverity },
    Goal { context: GoalContext },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DangerBand {
    Speculative,
    Decent,
    BigChance,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SaveQuality {
    Routine,
    Strong,
    WorldClass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FoulSeverity {
    Soft,
    Hard,
    Reckless,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum GoalContext {
    Opener,
    Equaliser,
    Extends,
    Consolation,
}

impl MatchEvent {
    pub fn new(minute: u8, event_type: EventType, side: Side, zone: Zone) -> Self {
        let (x, y) = pitch_position(minute, &event_type, side, zone, "");
        Self {
            minute,
            event_type,
            side,
            zone,
            player_id: None,
            secondary_player_id: None,
            detail: None,
            second: 0,
            x,
            y,
        }
    }

    pub fn with_player(mut self, player_id: &str) -> Self {
        // Re-place the event now the player is known, so two players doing the
        // same thing in the same minute do not land on the same spot.
        let (x, y) = pitch_position(
            self.minute,
            &self.event_type,
            self.side,
            self.zone,
            player_id,
        );
        self.x = x;
        self.y = y;
        self.player_id = Some(player_id.to_string());
        self
    }

    pub fn with_secondary(mut self, player_id: &str) -> Self {
        self.secondary_player_id = Some(player_id.to_string());
        self
    }

    pub fn with_detail(mut self, detail: EventDetail) -> Self {
        self.detail = Some(detail);
        self
    }

    pub fn is_goal(&self) -> bool {
        matches!(self.event_type, EventType::Goal | EventType::PenaltyGoal)
    }
}

// ---------------------------------------------------------------------------
// Spatial data
// ---------------------------------------------------------------------------
//
// The engine simulates five zones, not coordinates. A position is the zone the
// event really happened in, plus a spot inside it chosen by a stable hash of
// the event itself. No random numbers are drawn, so adding positions cannot
// change the result of a match.

/// FNV-1a. Small, stable across platforms and good enough to scatter events.
fn stable_hash(parts: &[&[u8]]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for part in parts {
        for byte in *part {
            h ^= u32::from(*byte);
            h = h.wrapping_mul(0x0100_0193);
        }
        h ^= 0xff;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// A value in `0.0..=1.0` taken from `bits` of the hash.
fn unit(hash: u32, shift: u32) -> f32 {
    ((hash >> shift) & 0x3ff) as f32 / 1023.0
}

fn lerp(from: f32, to: f32, t: f32) -> f32 {
    from + (to - from) * t
}

/// The stretch of the pitch (in metres from the home goal line) a zone covers.
fn zone_span(zone: Zone) -> (f32, f32) {
    match zone {
        Zone::HomeBox => (0.0, 16.5),
        Zone::HomeDefense => (16.5, 35.0),
        Zone::Midfield => (35.0, 70.0),
        Zone::AwayDefense => (70.0, 88.5),
        Zone::AwayBox => (88.5, 105.0),
    }
}

/// The goal line a side attacks: home shoots at the away goal.
fn attacking_goal_line(side: Side) -> f32 {
    match side {
        Side::Home => PITCH_LENGTH,
        Side::Away => 0.0,
    }
}

fn pitch_position(
    minute: u8,
    event_type: &EventType,
    side: Side,
    zone: Zone,
    player_id: &str,
) -> (f32, f32) {
    let type_tag = format!("{event_type:?}");
    let side_tag: &[u8] = match side {
        Side::Home => b"H",
        Side::Away => b"A",
    };
    let hash = stable_hash(&[
        &[minute],
        type_tag.as_bytes(),
        side_tag,
        player_id.as_bytes(),
    ]);
    let along = unit(hash, 0);
    let across = unit(hash, 10);
    let top_half = (hash >> 20) & 1 == 0;
    let centre = (PITCH_LENGTH / 2.0, PITCH_WIDTH / 2.0);

    match event_type {
        EventType::KickOff
        | EventType::SecondHalfStart
        | EventType::HalfTime
        | EventType::FullTime => centre,
        // Substitutions happen at the halfway line, on the touchline.
        EventType::Substitution => (PITCH_LENGTH / 2.0, 0.0),
        EventType::Corner => {
            let y = if top_half { 0.0 } else { PITCH_WIDTH };
            (attacking_goal_line(side), y)
        }
        // Taken by `side` from the edge of its own six-yard box.
        EventType::GoalKick => {
            let x = (attacking_goal_line(side.opposite()) - 5.5).abs();
            let y = if top_half { 24.84 } else { 43.16 };
            (x, y)
        }
        EventType::PenaltyGoal
        | EventType::PenaltyMiss
        | EventType::ShootoutGoal
        | EventType::ShootoutMiss => {
            let x = (attacking_goal_line(side) - 11.0).abs();
            (x, PITCH_WIDTH / 2.0)
        }
        // Also used as the marker that opens a shootout, with no real zone.
        EventType::PenaltyAwarded if zone == Zone::Midfield => centre,
        _ => {
            let (from, to) = zone_span(zone);
            let x = lerp(from, to, along);
            let y = match (event_type, zone) {
                // A cross comes in from one of the wings.
                (EventType::Cross, _) => {
                    if top_half {
                        lerp(2.0, 12.0, across)
                    } else {
                        lerp(56.0, 66.0, across)
                    }
                }
                // Inside a penalty area, stay between its side lines.
                (_, Zone::HomeBox | Zone::AwayBox) => lerp(13.85, 54.15, across),
                _ => lerp(2.0, 66.0, across),
            };
            (x, y)
        }
    }
}

/// Give every event a second within its minute, rising in the order the events
/// happened. Depends only on each event and its place in the minute, so
/// stamping the same list twice — or a list that has grown — never moves an
/// event that was already stamped.
pub fn stamp_seconds(events: &mut [MatchEvent]) {
    let mut current_minute: Option<u8> = None;
    let mut index_in_minute: u32 = 0;
    for event in events.iter_mut() {
        if current_minute == Some(event.minute) {
            index_in_minute += 1;
        } else {
            current_minute = Some(event.minute);
            index_in_minute = 0;
        }
        event.second = match event.event_type {
            EventType::KickOff | EventType::SecondHalfStart => 0,
            _ => {
                let jitter = stable_hash(&[
                    &[event.minute],
                    event.player_id.as_deref().unwrap_or("").as_bytes(),
                ]) % 5;
                (3 + index_in_minute * 7 + jitter).min(59) as u8
            }
        };
    }
}

/// Put events that belong to the same moment in the same place.
///
/// Each event is first placed on its own (see `pitch_position`), which leaves a
/// tackle metres away from the dribble it stopped, or a booking far from its
/// foul. This pass walks each minute in order and moves the follow-up event to
/// where the one before it happened. Like [`stamp_seconds`] it depends only on
/// the events and their order, so running it twice changes nothing.
pub fn link_positions(events: &mut [MatchEvent]) {
    for i in 1..events.len() {
        let (earlier, later) = events.split_at_mut(i);
        let previous = &earlier[i - 1];
        let event = &mut later[0];
        if previous.minute != event.minute {
            continue;
        }
        let same_spot = matches!(
            (&previous.event_type, &event.event_type),
            (EventType::PassIntercepted, EventType::Interception)
                | (EventType::DribbleTackled, EventType::Tackle)
                | (EventType::Tackle, EventType::Foul)
                | (
                    EventType::Foul,
                    EventType::YellowCard
                        | EventType::RedCard
                        | EventType::SecondYellow
                        | EventType::Injury
                        | EventType::FreeKick
                )
                | (
                    EventType::YellowCard | EventType::RedCard | EventType::SecondYellow,
                    EventType::Injury | EventType::FreeKick
                )
        );
        if same_spot {
            event.x = previous.x;
            event.y = previous.y;
        } else if previous.event_type == EventType::Dribble
            && event.event_type == EventType::Cross
            && previous.player_id == event.player_id
        {
            // The winger who just ran with the ball crosses from that wing, a
            // few strides further on.
            let towards_goal = if attacking_goal_line(event.side) > 0.0 {
                6.0
            } else {
                -6.0
            };
            event.x = (previous.x + towards_goal).clamp(1.0, PITCH_LENGTH - 1.0);
            event.y = if previous.y < PITCH_WIDTH / 2.0 {
                previous.y.min(10.0)
            } else {
                previous.y.max(PITCH_WIDTH - 10.0)
            };
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Side, Zone};

    #[test]
    fn new_event_has_no_detail() {
        let evt = MatchEvent::new(10, EventType::Goal, Side::Home, Zone::AwayBox);
        assert!(evt.detail.is_none());
    }

    #[test]
    fn with_detail_attaches_and_round_trips_through_serde() {
        let evt = MatchEvent::new(10, EventType::Goal, Side::Home, Zone::AwayBox)
            .with_player("p1")
            .with_detail(EventDetail::Goal {
                context: GoalContext::Equaliser,
            });
        let json = serde_json::to_string(&evt).unwrap();
        let back: MatchEvent = serde_json::from_str(&json).unwrap();
        assert_eq!(
            back.detail,
            Some(EventDetail::Goal {
                context: GoalContext::Equaliser
            })
        );
    }

    #[test]
    fn every_event_lands_on_the_pitch_and_inside_its_zone() {
        let zones = [
            Zone::HomeBox,
            Zone::HomeDefense,
            Zone::Midfield,
            Zone::AwayDefense,
            Zone::AwayBox,
        ];
        for minute in 0..=120u8 {
            for zone in zones {
                for side in [Side::Home, Side::Away] {
                    let evt = MatchEvent::new(minute, EventType::PassCompleted, side, zone)
                        .with_player("player-7");
                    let (from, to) = zone_span(zone);
                    assert!((from..=to).contains(&evt.x), "x {} outside {zone:?}", evt.x);
                    assert!(
                        (0.0..=PITCH_WIDTH).contains(&evt.y),
                        "y {} off the pitch",
                        evt.y
                    );
                }
            }
        }
    }

    #[test]
    fn position_is_stable_for_the_same_event() {
        let a = MatchEvent::new(33, EventType::Dribble, Side::Away, Zone::HomeDefense)
            .with_player("p9");
        let b = MatchEvent::new(33, EventType::Dribble, Side::Away, Zone::HomeDefense)
            .with_player("p9");
        assert_eq!((a.x, a.y), (b.x, b.y));
    }

    #[test]
    fn set_pieces_are_placed_on_their_marks() {
        let kick_off = MatchEvent::new(0, EventType::KickOff, Side::Home, Zone::Midfield);
        assert_eq!((kick_off.x, kick_off.y), (52.5, 34.0));

        let home_corner = MatchEvent::new(12, EventType::Corner, Side::Home, Zone::AwayDefense);
        assert_eq!(home_corner.x, PITCH_LENGTH);
        assert!(home_corner.y == 0.0 || home_corner.y == PITCH_WIDTH);

        let away_penalty = MatchEvent::new(70, EventType::PenaltyGoal, Side::Away, Zone::HomeBox);
        assert_eq!((away_penalty.x, away_penalty.y), (11.0, 34.0));

        let home_goal_kick = MatchEvent::new(5, EventType::GoalKick, Side::Home, Zone::HomeBox);
        assert_eq!(home_goal_kick.x, 5.5);
    }

    #[test]
    fn crosses_come_from_the_wings() {
        for minute in 1..=90u8 {
            let evt = MatchEvent::new(minute, EventType::Cross, Side::Home, Zone::AwayDefense)
                .with_player("winger");
            assert!(evt.y <= 12.0 || evt.y >= 56.0, "cross from y {}", evt.y);
        }
    }

    #[test]
    fn seconds_rise_within_a_minute_and_restamping_changes_nothing() {
        let mut events = vec![
            MatchEvent::new(0, EventType::KickOff, Side::Home, Zone::Midfield),
            MatchEvent::new(1, EventType::PassCompleted, Side::Home, Zone::Midfield)
                .with_player("a"),
            MatchEvent::new(1, EventType::Dribble, Side::Home, Zone::AwayDefense).with_player("b"),
            MatchEvent::new(1, EventType::Cross, Side::Home, Zone::AwayDefense).with_player("b"),
            MatchEvent::new(2, EventType::Tackle, Side::Away, Zone::Midfield).with_player("c"),
        ];
        stamp_seconds(&mut events);
        assert_eq!(events[0].second, 0);
        assert!(events[1].second < events[2].second);
        assert!(events[2].second < events[3].second);
        assert!(events.iter().all(|e| e.second < 60));

        let first_pass: Vec<u8> = events.iter().map(|e| e.second).collect();
        events.push(MatchEvent::new(
            2,
            EventType::Foul,
            Side::Away,
            Zone::Midfield,
        ));
        stamp_seconds(&mut events);
        let second_pass: Vec<u8> = events.iter().map(|e| e.second).collect();
        assert_eq!(first_pass[..], second_pass[..first_pass.len()]);
    }

    #[test]
    fn events_saved_before_positions_existed_still_load() {
        let json = r#"{"minute":10,"event_type":"Goal","side":"Home","zone":"AwayBox","player_id":"p1","secondary_player_id":null}"#;
        let evt: MatchEvent = serde_json::from_str(json).unwrap();
        assert_eq!((evt.second, evt.x, evt.y), (0, 52.5, 34.0));
    }

    #[test]
    fn follow_up_events_happen_where_the_first_one_did() {
        let mut events = vec![
            MatchEvent::new(8, EventType::DribbleTackled, Side::Home, Zone::AwayDefense)
                .with_player("a"),
            MatchEvent::new(8, EventType::Tackle, Side::Away, Zone::AwayDefense).with_player("b"),
            MatchEvent::new(8, EventType::Foul, Side::Away, Zone::AwayDefense).with_player("b"),
            MatchEvent::new(8, EventType::YellowCard, Side::Away, Zone::AwayDefense)
                .with_player("b"),
            // A new minute starts afresh.
            MatchEvent::new(9, EventType::Tackle, Side::Home, Zone::Midfield).with_player("c"),
        ];
        let untouched = (events[4].x, events[4].y);
        link_positions(&mut events);
        let spot = (events[0].x, events[0].y);
        for linked in &events[1..4] {
            assert_eq!((linked.x, linked.y), spot);
        }
        assert_eq!((events[4].x, events[4].y), untouched);

        let once: Vec<(f32, f32)> = events.iter().map(|e| (e.x, e.y)).collect();
        link_positions(&mut events);
        let twice: Vec<(f32, f32)> = events.iter().map(|e| (e.x, e.y)).collect();
        assert_eq!(once, twice);
    }

    #[test]
    fn a_winger_crosses_from_the_wing_they_ran_down() {
        let mut events = vec![
            MatchEvent::new(8, EventType::Dribble, Side::Home, Zone::AwayDefense).with_player("w"),
            MatchEvent::new(8, EventType::Cross, Side::Home, Zone::AwayDefense).with_player("w"),
        ];
        events[0].x = 78.0;
        events[0].y = 50.0;
        link_positions(&mut events);
        assert_eq!(events[1].x, 84.0);
        assert!(events[1].y >= 58.0, "crossed from y {}", events[1].y);
    }
}
