import Foundation

enum JourneyText {
    static func leaveIn(_ a: NextAnswer, _ j: Journey, now: Date) -> String {
        if a.phase == "waiting" { return a.leaveHeadline(now: now) ?? L("Leave now") }
        guard let left = secondsToLeave(a, j, now: now) else { return L("Leave now") }
        switch countdown(left) {
        case .min(let m): return L("Leave in %@ min", m)
        case .minS(let m, let s): return L("Leave in %@ min %@ s", m, s)
        case .s(let s): return L("Leave in %@ s", s)
        }
    }

    static func leaveTime(_ a: NextAnswer, _ j: Journey, now: Date) -> String? {
        secondsToLeave(a, j, now: now).map {
            switch countdown($0) {
            case .min(let m): L("%@ min", m)
            case .minS(let m, let s): L("%@ min %@ s", m, s)
            case .s(let s): L("%@ s", s)
            }
        }
    }

    static func secondsToLeave(_ a: NextAnswer, _ j: Journey, now: Date) -> Int? {
        guard a.phase != "waiting", let at = a.leaveAt, j.leave != nil, now < at else { return nil }
        return Int(at.timeIntervalSince(now))
    }

    private enum Countdown { case min(String), minS(String, String), s(String) }

    private static func countdown(_ left: Int) -> Countdown {
        if left >= 120 { return .min("\((left + 30) / 60)") }
        if left >= 60 { return .minS("\(left / 60)", "\(left % 60)") }
        return .s("\(max(1, left))")
    }

    static func to(_ j: Journey) -> String { j.title ?? j.to }

    static func by(_ a: NextAnswer, _ j: Journey, now: Date) -> String? {
        guard a.phase != "waiting", let at = a.leaveAt, now < at else { return nil }
        return j.byText
    }

    static func arrive(_ j: Journey) -> String? { j.arriveText }

    static func backup(_ a: NextAnswer, _ j: Journey) -> String? { j.backupText }

    static func walk(_ j: Journey) -> String? { j.walkText }

    static func walkEnd(_ j: Journey) -> String? { j.walkEndText }

    static func ride(_ j: Journey) -> String? { j.rideText }

    static func arriveWhere(_ j: Journey) -> String? { j.slack ?? j.arriveWhere }

    static func busIn(_ j: Journey, now: Date) -> String? {
        guard let at = j.boardDate else { return nil }
        let left = Int(at.timeIntervalSince(now))
        guard left > 0 else { return nil }
        return inTime(left)
    }

    static func inTime(_ left: Int) -> String {
        left >= 120 ? L("in %@ min", "\((left + 30) / 60)") : L("in %@ min %@ s", "\(left / 60)", "\(left % 60)")
    }

    static func leaves(left: Int) -> String {
        left > 60
            ? L("Leaves in %@ min %@ s", "\(left / 60)", "\(left % 60)")
            : left > 0
                ? L("Leaves in %@ s", "\(left)")
                : L("Left %@ min ago", "\(max(1, (-left + 59) / 60))")
    }
}
