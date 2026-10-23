import Foundation

#if canImport(ActivityKit)
    import ActivityKit
#endif

/// The Live Activity for a trip under way (Android's live notification): on
/// the Lock Screen and in the Dynamic Island from "time to go" until you're
/// there. The app starts, updates and ends it from each answer (LiveTrip);
/// the server updates and ends it by push (apnsla: tokens), with the same
/// state built the same way from the card.
struct TripAttributes: Sendable {
    /// The trip it's about: the card's trip key, else when the class starts.
    /// A different trip ends this one and starts its own.
    var trip: String

    /// What it shows, the server's words but for the countdown, which ticks
    /// on the phone. The keys and types are the server's push payload's
    /// (`content-state`): every key present, null when it doesn't apply, and
    /// times in whole seconds since 1970.
    struct ContentState: Codable, Hashable, Sendable {
        /// idle, due, heading, waiting, riding, missed or arrived.
        var phase: String
        /// "On your way", "On the bus".
        var phaseText: String?
        /// card.title: "D2 · 09:42", "On the R2".
        var headline: String
        /// card.line: "Leave by 09:38 · D2 from PGP", "On the R2 · off at UTown ~09:52".
        var line: String
        /// 12 characters at most ("Leave 09:38", "Off 09:52"): the Dynamic Island.
        var glance: String
        /// Where to, short: "GEA1000".
        var to: String?
        /// The bus, as painted.
        var svc: String?
        var color: String?
        /// Where you board, and where you get off.
        var stop: String?
        var off: String?
        /// When to leave; when the bus leaves `stop` (on the bus, when it left); when you get off.
        var leaveAt: Int?
        var departAt: Int?
        var arriveAt: Int?
        /// An estimate, not a bus seen: times shown with "~".
        var estimated: Bool
        /// The planned bus has left and nothing says whether you're on it: never "Leave now".
        var gone: Bool
        /// The trip misses the class.
        var late: Bool
        var staleAt: Int?
    }
}

#if canImport(ActivityKit)
    extension TripAttributes: ActivityAttributes {}
#endif

extension TripAttributes.ContentState {
    private static func date(_ s: Int?) -> Date? { s.map { Date(timeIntervalSince1970: TimeInterval($0)) } }

    var leaveDate: Date? { Self.date(leaveAt) }
    var departDate: Date? { Self.date(departAt) }
    var arriveDate: Date? { Self.date(arriveAt) }
    var staleDate: Date? { Self.date(staleAt) }

    /// What the countdown counts to at `now` (the phone's clock): getting off
    /// on the bus, leaving before it's time to go, else the bus. Nil when
    /// there's nothing ahead.
    func countdown(now: Date) -> (to: Date, kind: String)? {
        if phase == "riding" { return arriveDate.flatMap { $0 > now ? ($0, "off") : nil } }
        if !gone, ["idle", "due"].contains(phase), let at = leaveDate, at > now { return (at, "leave") }
        if let at = departDate, at > now, phase != "missed" { return (at, "bus") }
        return nil
    }

    /// The countdown as the Live Activity draws it, on the phone's clock:
    /// `now` is the phone's and `skew` turns it into the server's, which the
    /// times are on. One clock reading for both ends, and never backwards,
    /// so `Text(timerInterval:)` can't be handed a range whose end is before its start.
    func countdown(phoneNow now: Date, skew: TimeInterval) -> (range: ClosedRange<Date>, kind: String)? {
        guard let c = countdown(now: now.addingTimeInterval(skew)) else { return nil }
        return (now...max(now, c.to.addingTimeInterval(-skew)), c.kind)
    }

    /// With no arrival time, how long after the bus (or the leave-by) a trip nothing has updated is taken as over.
    static let unheardS: TimeInterval = 3600

    /// When a trip nothing can update any more (no push) is over, on the
    /// server's clock: `linger` after getting off, else `unheardS` after the
    /// bus or the leave-by. Nil when it says neither.
    func overAt(linger: TimeInterval) -> Date? {
        if let at = arriveDate { return at.addingTimeInterval(linger) }
        return (departDate ?? leaveDate).map { $0.addingTimeInterval(Self.unheardS) }
    }

    /// The state for `answer`, or nil when there's no trip under way: the
    /// server's (liveActivityState in apns.ts), rule for rule, since the app
    /// and the server's pushes update the same activity in turn
    /// (fixtures/live-activity.json holds the two together).
    static func of(_ a: NextAnswer) -> Self? {
        guard let card = a.card, TripPrefs.tripPhases.contains(card.phase), a.mode != "rest" else { return nil }
        let ride = card.ride
        let j = card.journey
        let bus = j?.bus
        let leave = a.leave
        let svc = ride?.svc ?? bus?.svc ?? leave?.svc
        let onBoard = card.phase == "riding" || card.phase == "arrived"
        func epoch(_ iso: String?) -> Int? { iso.flatMap(parseISODate).map { Int($0.timeIntervalSince1970.rounded(.down)) } }
        let off: String? =
            if let ride { ride.stops.last?.name } else if let j { j.off ?? j.toStop } else { leave?.off ?? leave?.toStop }
        return Self(
            phase: card.phase,
            phaseText: card.phaseText,
            headline: card.title ?? a.label,
            line: card.line ?? a.label,
            glance: card.glance ?? "",
            to: j?.place ?? a.dest?.label,
            svc: svc,
            color: svc == nil ? nil : bus?.svc == svc ? bus?.color : ride?.color,
            stop: ride.map { $0.stops.first?.name } ?? bus?.stop ?? leave?.stop,
            off: off,
            leaveAt: onBoard ? nil : epoch(leave?.at),
            departAt: ride.map { epoch($0.board) } ?? epoch(j?.boardAt ?? leave?.board),
            arriveAt: ride.map { epoch($0.arrive) } ?? epoch(leave?.arrive),
            estimated: leave?.estimated ?? false,
            gone: card.gone,
            late: card.late,
            staleAt: epoch(card.staleAt)
        )
    }
}
