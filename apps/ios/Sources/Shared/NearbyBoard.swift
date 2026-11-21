import Foundation

struct StopBus: Equatable, Sendable {
    let svc: String
    let color: String?
    let paid: Bool
    let at: Date
    let live: Bool
    let crowd: String?
    let next: String?
    let end: String?
    let endsHere: Bool
    let later: [Date]
    var first = false
    var via: [String] = []
}

enum NearbyBoard {
    static let gone: TimeInterval = 60
    static let minutesUnder: TimeInterval = 15 * 60

    static func buses(_ stop: NearbyStop, fetchedAt: Date, now: Date, skew: TimeInterval = 0) -> [StopBus] {
        let running = running(stop, fetchedAt: fetchedAt, now: now)
        return running.isEmpty ? firsts(stop, now: now, skew: skew) : running
    }

    private static func running(_ stop: NearbyStop, fetchedAt: Date, now: Date) -> [StopBus] {
        stop.board.compactMap { r -> StopBus? in
            guard let first = r.etaS else { return nil }
            let times = ([(first, r.quality == "live", r.crowd)] + r.later.map { ($0.etaS, $0.quality == "live", nil as String?) })
                .map { (due: $0, at: fetchedAt.addingTimeInterval(TimeInterval($0.0))) }
                .filter { $0.at > now.addingTimeInterval(-gone) }
            guard let soonest = times.first else { return nil }
            return StopBus(
                svc: r.svc, color: r.color, paid: r.paid, at: soonest.at, live: soonest.due.1, crowd: soonest.due.2, next: r.towards.first,
                end: r.towards.count > 1 ? r.towards.last : nil, endsHere: r.endsHere, later: times.dropFirst().map(\.at), via: r.via)
        }
        .sorted { $0.at < $1.at }
    }

    private static func firsts(_ stop: NearbyStop, now: Date, skew: TimeInterval) -> [StopBus] {
        stop.board.compactMap { r -> StopBus? in
            guard !r.running, let resumes = r.resumesAt.flatMap(parseISODate) else { return nil }
            let at = resumes.addingTimeInterval(-skew)
            guard at > now else { return nil }
            return StopBus(
                svc: r.svc, color: r.color, paid: r.paid, at: at, live: false, crowd: nil, next: r.towards.first,
                end: r.towards.count > 1 ? r.towards.last : nil, endsHere: r.endsHere, later: [], first: true, via: r.via)
        }
        .sorted { $0.at < $1.at }
    }

    static func endIfNeeded(_ bus: StopBus, shown: [StopBus]) -> String? {
        guard let end = bus.end else { return nil }
        return shown.contains { $0.svc != bus.svc && $0.next == bus.next && $0.end != end } ? end : nil
    }

    static func minutesLeft(_ at: Date, now: Date) -> Int? {
        let left = at.timeIntervalSince(now)
        guard left < minutesUnder else { return nil }
        return max(0, Int((left / 60).rounded(.down)))
    }

    static func redrawAt(_ buses: [StopBus], now: Date, minutesUntil: Date? = nil) -> Date? {
        let goes = buses.flatMap { [$0.at] + $0.later }.map { $0.addingTimeInterval(gone) }
        var ticks: [Date] = []
        if let until = minutesUntil {
            for b in buses where !b.first {
                for m in 1...Int(minutesUnder / 60) {
                    let t = b.at.addingTimeInterval(-TimeInterval(m * 60))
                    if t < until { ticks.append(t) }
                }
            }
        }
        return (goes + ticks).filter { $0 > now }.min()
    }

    static func redraws(
        _ stops: [NearbyStop], fetchedAt: Date, now: Date, until: Date, minutesUntil: Date?, skew: TimeInterval = 0, max: Int = 60
    ) -> [Date] {
        var out: [Date] = []
        var t = now
        while out.count < max {
            let shown = stops.flatMap { buses($0, fetchedAt: fetchedAt, now: t, skew: skew) }
            guard let next = redrawAt(shown, now: t, minutesUntil: minutesUntil), next < until else { break }
            out.append(next)
            t = next
        }
        return out
    }

    static func beside(_ stops: [NearbyStop], buses: (NearbyStop) -> [StopBus]) -> NearbyStop? {
        guard let first = stops.first else { return nil }
        let rest = stops.dropFirst()
        return rest.first { $0.stop.code == first.opposite } ?? rest.first { !buses($0).isEmpty }
    }

    static func firstLabel(_ at: Date, now: Date) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = .campus
        let days = cal.dateComponents([.day], from: cal.startOfDay(for: now), to: cal.startOfDay(for: at)).day ?? 0
        if days <= 0 { return L("First bus") }
        if days == 1 { return L("First bus tomorrow") }
        let f = DateFormatter()
        f.locale = Lang.locale
        f.timeZone = .campus
        f.setLocalizedDateFormatFromTemplate("EEEE")
        return L("First bus %@", f.string(from: at))
    }

    static func minutesText(_ left: Int, live: Bool) -> String {
        guard live else { return L("~%@ min", "\(max(1, left))") }
        return left == 0 ? L("now") : L("%@ min", "\(left)")
    }
}

func shortCampusTime(_ d: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .campus
    f.dateFormat = Clock.hour12 ? "h:mm" : "HH:mm"
    return f.string(from: d)
}

struct NearbyFit: Equatable {
    enum Kind: Equatable { case mini, bar, rows, tiles, sides }

    var kind: Kind
    var cols = 1
    var rows = 1
    var footer = false

    var shown: Int { cols * rows }

    static func tile(_ cols: Int) -> CGFloat { cols >= 3 ? 112 : 98 }

    static let row: CGFloat = 36
    static let footerH: CGFloat = 22
    static let maxRows = 5
    static let sidesMaxRows = 8

    static let sideRow: CGFloat = 30
    static let sideRowNew: CGFloat = 34
    static let sideHead: CGFloat = 20
    static let sideHeadNew: CGFloat = 34
    static let sidesSky: CGFloat = 42
    static let bottom: CGFloat = 6

    static func sides(width: CGFloat, height: CGFloat, sky: CGFloat, newcomer: Bool) -> NearbyFit? {
        guard width >= 300, height >= 130 else { return nil }
        let head = newcomer ? sideHeadNew : sideHead
        let row = newcomer ? sideRowNew : sideRow
        let rows = Int(((height - sky + 1 - head - bottom) / (row + 1)).rounded(.down))
        return rows < 2 ? nil : NearbyFit(kind: .sides, cols: 2, rows: min(rows, sidesMaxRows))
    }

    static func of(width: CGFloat, height: CGFloat, sky: CGFloat) -> NearbyFit {
        if height < 130 { return width < 220 ? NearbyFit(kind: .mini) : NearbyFit(kind: .bar, cols: 2) }
        let area = height - sky + 1
        let cols = width >= 380 ? 3 : 2
        let t = tile(cols)
        if width < 300 || area < t { return NearbyFit(kind: .rows, rows: min(max(Int(area / row), 1), maxRows)) }
        let bare = Int(area / t)
        let withFooter = Int((area - footerH) / t)
        if bare < 2 { return NearbyFit(kind: .tiles, cols: cols, rows: 1) }
        return bare > withFooter
            ? NearbyFit(kind: .tiles, cols: cols, rows: min(bare, 4))
            : NearbyFit(kind: .tiles, cols: cols, rows: min(withFooter, 4), footer: true)
    }
}
