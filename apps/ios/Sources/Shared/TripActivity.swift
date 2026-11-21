import Foundation

#if canImport(ActivityKit)
    import ActivityKit
#endif

struct TripAttributes: Sendable {
    var trip: String

    struct ContentState: Codable, Hashable, Sendable {
        var phase: String
        var phaseText: String?
        var headline: String
        var line: String
        var glance: String
        var to: String?
        var svc: String?
        var color: String?
        var stop: String?
        var off: String?
        var leaveAt: Int?
        var departAt: Int?
        var arriveAt: Int?
        var estimated: Bool
        var gone: Bool
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

    func countdown(now: Date) -> (to: Date, kind: String)? {
        if phase == "riding" { return arriveDate.flatMap { $0 > now ? ($0, "off") : nil } }
        if !gone, ["idle", "due"].contains(phase), let at = leaveDate, at > now { return (at, "leave") }
        if let at = departDate, at > now, phase != "missed" { return (at, "bus") }
        return nil
    }

    func countdown(phoneNow now: Date, skew: TimeInterval) -> (range: ClosedRange<Date>, kind: String)? {
        guard let c = countdown(now: now.addingTimeInterval(skew)) else { return nil }
        return (now...max(now, c.to.addingTimeInterval(-skew)), c.kind)
    }

    static func countdownWords(_ kind: String) -> (before: String, after: String) {
        switch kind {
        case "leave": around(L("Leave in %@"))
        case "off": around(L("Off in %@"))
        default: around(L("Bus in %@"))
        }
    }

    static func around(_ phrase: String) -> (before: String, after: String) {
        let parts = phrase.components(separatedBy: "%@")
        var before = parts.first ?? ""
        var after = parts.count > 1 ? parts[1] : ""
        if let c = before.last, !c.isASCII, !c.isWhitespace { before += " " }
        if let c = after.first, !c.isASCII, !c.isWhitespace { after = " " + after }
        return (before, after)
    }

    var countdownPlace: String? { (phase == "riding" || phase == "arrived" ? off : stop) ?? to }

    static let unheardS: TimeInterval = 3600

    func overAt(linger: TimeInterval) -> Date? {
        if let at = arriveDate { return at.addingTimeInterval(linger) }
        return (departDate ?? leaveDate).map { $0.addingTimeInterval(Self.unheardS) }
    }

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
