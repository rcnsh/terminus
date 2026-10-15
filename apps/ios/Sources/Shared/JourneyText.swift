import Foundation

/// The few words the card styles put round the server's journey, shared by
/// Now, the widgets and the Live Activity. The server words them
/// (`journey.title`, `byText`, `arriveText`, `backupText`, ...); only the
/// countdown is worked out here, because it ticks, and the rest only for an
/// older server that doesn't send them. As Android's JourneyText.
enum JourneyText {
    /// "Leave in 4 min", "Leave in 1 min 5 s", "Leave in 45 s", then "Leave
    /// now". At the stop it's the bus to wait for ("D2 at 4:05 PM"), as the
    /// server says it. Minutes are rounded until the last two, then exact.
    static func leaveIn(_ a: NextAnswer, _ j: Journey, now: Date) -> String {
        if a.phase == "waiting" { return a.leaveHeadline(now: now) ?? L("Leave now") }
        guard let left = secondsToLeave(a, j, now: now) else { return L("Leave now") }
        return countdown(left, min: "Leave in %@ min", minS: "Leave in %@ min %@ s", s: "Leave in %@ s")
    }

    /// The time inside [leaveIn]'s headline ("6 min" of "Leave in 6 min"),
    /// for the card to colour; nil when there's none ("Leave now").
    static func leaveTime(_ a: NextAnswer, _ j: Journey, now: Date) -> String? {
        secondsToLeave(a, j, now: now).map { countdown($0, min: "%@ min", minS: "%@ min %@ s", s: "%@ s") }
    }

    /// Whole seconds until it's time to leave; nil at the stop, with no leave time, or once it's passed.
    static func secondsToLeave(_ a: NextAnswer, _ j: Journey, now: Date) -> Int? {
        guard a.phase != "waiting", let at = a.leaveAt, j.leave != nil, now < at else { return nil }
        return Int(at.timeIntervalSince(now))
    }

    private static func countdown(_ left: Int, min: String, minS: String, s: String) -> String {
        if left >= 120 { return L(min, "\((left + 30) / 60)") }
        if left >= 60 { return L(minS, "\(left / 60)", "\(left % 60)") }
        return L(s, "\(max(1, left))")
    }

    /// "To GEA1000 @ UTown · starts 10:00".
    static func to(_ a: NextAnswer, _ j: Journey) -> String {
        if let t = j.title { return t }
        var parts = [L("To %@", j.to)]
        if a.isClassPlan, let c = a.classAt { parts.append(L("starts %@", campusTime(c))) }
        return parts.joined(separator: " · ")
    }

    /// "by 4:01 PM" under the countdown, until it's time to go.
    static func by(_ a: NextAnswer, _ j: Journey, now: Date) -> String? {
        guard a.phase != "waiting", let at = a.leaveAt, now < at else { return nil }
        return j.byText ?? j.leave.map { L("by %@", $0) }
    }

    /// "Arrive 4:08 PM", with a class's "9 min early".
    static func arrive(_ j: Journey) -> String? {
        if let t = j.arriveText { return t }
        return j.arrive.map { ([L("Arrive %@", $0)] + [j.slack].compactMap { $0 }).joined(separator: " · ") }
    }

    /// "Or A1 at 4:05 PM from PGP"; for a class, the sooner bus to go now on.
    /// On foot, the bus the walk beats: "D1 would be 16 min".
    static func backup(_ a: NextAnswer, _ j: Journey) -> String? {
        if let t = j.backupText { return t }
        if j.bus == nil { return j.why }
        guard let b = j.backup else { return nil }
        return L(a.isClassPlan ? "Or go now: %@ at %@ from %@" : "Or %@ at %@ from %@", b.paid ? "\(b.svc) ($)" : b.svc, b.board, b.stop)
    }

    /// "5 min walk".
    static func walk(_ j: Journey) -> String? { j.walkText ?? j.walk.map { L("%@ walk", $0) } }

    /// The walk on from the stop at the far end.
    static func walkEnd(_ j: Journey) -> String? { j.walkEndText ?? j.walkEnd.map { L("%@ walk", $0) } }

    /// "10 min ride · off at Opp NUSS".
    static func ride(_ j: Journey) -> String? {
        if let t = j.rideText { return t }
        let parts = [j.ride.map { L("%@ ride", $0) }, j.off.map { L("off at %@", $0) }].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Under the arrival time: "9 min early", else "2 min walk from UTown" or "at UTown".
    static func arriveWhere(_ j: Journey) -> String {
        j.slack ?? j.arriveWhere ?? j.walkEnd.map { L("%@ walk from %@", $0, j.toStop) } ?? L("at %@", j.toStop)
    }

    /// "in 4 min" to the bus leaving, or nil once it has (or on foot).
    static func busIn(_ j: Journey, now: Date) -> String? {
        guard let at = j.boardDate else { return nil }
        let left = Int(at.timeIntervalSince(now))
        guard left > 0 else { return nil }
        return left >= 120 ? L("in %@ min", "\((left + 30) / 60)") : L("in %@ min %@ s", "\(left / 60)", "\(left % 60)")
    }
}
