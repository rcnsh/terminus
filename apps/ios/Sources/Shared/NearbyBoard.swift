import Foundation

/// A service's next bus at a stop, as the Buses near you widget shows it:
/// worked out once from a fetched board, its times on this phone's clock.
/// Shown as clock times ("9:42"), which stay true between redraws where a
/// countdown would stand still. As Android's StopBus.
struct StopBus: Equatable, Sendable {
    let svc: String
    let color: String?
    let paid: Bool
    /// When it's due, on this phone's clock.
    let at: Date
    let live: Bool
    /// How full it is ("low", "medium", "high"); only the server's next bus has one.
    let crowd: String?
    /// Its next stop (`towards[0]`); nil at the end of the line, or from an older server.
    let next: String?
    /// Where its line ends, when that isn't the next stop.
    let end: String?
    let endsHere: Bool
    /// The buses after it, on this phone's clock.
    let later: [Date]
    /// The service's first bus when it starts again: none of the stop's
    /// services is running now. A timetable's time.
    var first = false
    /// The well-known places it passes from here (the server's `via`), for New to NUS.
    var via: [String] = []
}

/// The Buses near you widget's sums, kept out of the views so they're tested. As Android's NearbyBoard.
enum NearbyBoard {
    /// A bus stays shown this long after it's due: it may be at the stop, or a little late.
    static let gone: TimeInterval = 60
    /// A bus says how many minutes until it under this; further off, its clock time says enough.
    static let minutesUnder: TimeInterval = 15 * 60

    /// The services at `stop` with a time, soonest first, from a board fetched
    /// at `fetchedAt` (this phone's clock, as `now`). A bus gone by `now` gives
    /// way to the service's next one; a service with none left isn't shown.
    /// With none running at all, each service's first bus when it starts again
    /// (`StopBus.first`), from a board asked for with `stopped=1`; `skew` (the
    /// server's clock less this phone's) puts the server's times on this phone's clock.
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

    /// Where `bus` ends, when the widget should say so: another bus in `shown`
    /// has the same next stop but ends somewhere else, so the next stop alone
    /// wouldn't tell them apart (A1, D2 and K all stop next at LT27 from Kent Ridge MRT).
    static func endIfNeeded(_ bus: StopBus, shown: [StopBus]) -> String? {
        guard let end = bus.end else { return nil }
        return shown.contains { $0.svc != bus.svc && $0.next == bus.next && $0.end != end } ? end : nil
    }

    /// Whole minutes until a bus due at `at`, rounded down so it's never later
    /// than said ("6 min" from 6:59 to 6:00 away), 0 in its last minute ("now");
    /// nil from `minutesUnder` away.
    static func minutesLeft(_ at: Date, now: Date) -> Int? {
        let left = at.timeIntervalSince(now)
        guard left < minutesUnder else { return nil }
        return max(0, Int((left / 60).rounded(.down)))
    }

    /// When the widget next looks different with nothing new: a shown bus going
    /// (`gone` after it's due), and before `minutesUntil` each minute off a shown
    /// bus's count (`minutesLeft`). A bus after a shown one counts once it's
    /// shown, from the redraw as the one before it goes.
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

    /// Every moment from `now` until `until` the widget looks different with
    /// nothing new, `stops`' buses worked out again at each (a gone bus's
    /// successor counts from then), at most `max` of them: a timeline's entries.
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

    /// The stop beside the first of `stops` (as shown) on a widget showing
    /// both sides of the road: its opposite stop where the board has it, else
    /// the next stop with a bus (`buses` gives each stop's). Nil with neither:
    /// the widget shows the one stop.
    static func beside(_ stops: [NearbyStop], buses: (NearbyStop) -> [StopBus]) -> NearbyStop? {
        guard let first = stops.first else { return nil }
        let rest = stops.dropFirst()
        return rest.first { $0.stop.code == first.opposite } ?? rest.first { !buses($0).isEmpty }
    }

    /// "First bus"; "First bus tomorrow", "First bus Monday" when it isn't
    /// today on campus. `at` and `now` on the same clock.
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

    /// How long until a bus `left` whole minutes off: "6 min", "~6 min" for a timetable's time, "now" in its last minute.
    static func minutesText(_ left: Int, live: Bool) -> String {
        if left == 0 { return L("now") }
        return live ? L("%@ min", "\(left)") : L("~%@ min", "\(left)")
    }
}

/// A clock time in campus time, short: hours and minutes in the account's
/// 12- or 24-hour style without AM or PM ("9:42"). A bus is due within the
/// hour, and "9:42 AM" doesn't fit a tile. As Android's shortClock.
func shortCampusTime(_ d: Date) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = .campus
    f.dateFormat = Clock.hour12 ? "h:mm" : "HH:mm"
    return f.string(from: d)
}

/// How a Buses near you widget lays itself out by its size: rows with the
/// time at the end (narrow ones), or tiles under the sky, two or three across,
/// more rows as it gets taller, the rest along the bottom; or both sides of
/// the road (`sides`). As Android's NearbyFit, by points rather than dp.
struct NearbyFit: Equatable {
    enum Kind: Equatable { case mini, bar, rows, tiles, sides }

    var kind: Kind
    var cols = 1
    var rows = 1
    /// Room under the rows for the services that don't fit.
    var footer = false

    var shown: Int { cols * rows }

    /// A tile at its smallest: the time, two lines for the next stop, the pills;
    /// three across, the later buses have a line of their own too.
    static func tile(_ cols: Int) -> CGFloat { cols >= 3 ? 112 : 98 }

    static let row: CGFloat = 36
    static let footerH: CGFloat = 22
    static let maxRows = 5
    /// A side's rows on a large widget: more than Android's five (a Glance
    /// column's limit), so a busy stop's buses fill the room rather than leave it bare.
    static let sidesMaxRows = 8

    /// Both sides of the road: a row a bus, and the heading over each side; New to NUS adds a line to each.
    static let sideRow: CGFloat = 30
    static let sideRowNew: CGFloat = 34
    static let sideHead: CGFloat = 20
    static let sideHeadNew: CGFloat = 34
    /// The slim sky over both sides: the stop's name, Now and ↻ on one line.
    static let sidesSky: CGFloat = 42
    /// Clear of the widget's rounded corners.
    static let bottom: CGFloat = 6

    /// Both sides of the road, a column each, where the widget is wide and
    /// tall enough for a few rows in each: as many rows as fit, up to
    /// `sidesMaxRows`. Nil where it isn't: `of`'s layouts then.
    static func sides(width: CGFloat, height: CGFloat, sky: CGFloat, newcomer: Bool) -> NearbyFit? {
        guard width >= 300, height >= 130 else { return nil }
        let head = newcomer ? sideHeadNew : sideHead
        let row = newcomer ? sideRowNew : sideRow
        let rows = Int(((height - sky + 1 - head - bottom) / (row + 1)).rounded(.down))
        return rows < 2 ? nil : NearbyFit(kind: .sides, cols: 2, rows: min(rows, sidesMaxRows))
    }

    /// `sky`: the sky over the buses.
    static func of(width: CGFloat, height: CGFloat, sky: CGFloat) -> NearbyFit {
        if height < 130 { return width < 220 ? NearbyFit(kind: .mini) : NearbyFit(kind: .bar, cols: 2) }
        // The home screen's sizes come a fraction short of whole points: a point to spare.
        let area = height - sky + 1
        let cols = width >= 380 ? 3 : 2
        let t = tile(cols)
        // Too narrow for two columns, or too short for a tile: rows.
        if width < 300 || area < t { return NearbyFit(kind: .rows, rows: min(max(Int(area / row), 1), maxRows)) }
        // More rows of tiles where they fit, else room for the rest under them.
        let bare = Int(area / t)
        let withFooter = Int((area - footerH) / t)
        if bare < 2 { return NearbyFit(kind: .tiles, cols: cols, rows: 1) }
        return bare > withFooter
            ? NearbyFit(kind: .tiles, cols: cols, rows: min(bare, 4))
            : NearbyFit(kind: .tiles, cols: cols, rows: min(withFooter, 4), footer: true)
    }
}
