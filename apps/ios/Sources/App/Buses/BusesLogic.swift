import Foundation

/*
 * The Stops tab's rules, apart from its screens so they're unit tested
 * (Tests/BusesTests.swift), as Android's Buses.kt: the pins and the home's
 * pages of them, the list of lines, the search, a line as it's drawn, and
 * the words worked out here for an older server. Every time shown is one the API gave.
 */

/// A page opened over the tab's home: a stop's board, or a service's line.
enum BusRoute: Hashable {
    case stop(String)
    /// `from`: the stop it was opened from, highlighted on the line with its time.
    case line(svc: String, from: String?)
}

/// The account's pinned stops, as the profile keeps them.
enum BusPins {
    /// The profile's limit when it hasn't said.
    static let defaultMax = 8

    /// Pinned: unpinned. Otherwise pinned at the end, unless there are `max` already.
    static func toggle(_ pins: [String], _ code: String, max: Int = defaultMax) -> [String] {
        if pins.contains(code) { return pins.filter { $0 != code } }
        return pins.count >= max ? pins : pins + [code]
    }

    /// The pinned stops the tab's home shows, in the profile's order: each once, at most `max`.
    static func shown(_ pins: [String], max: Int = defaultMax) -> [String] {
        var seen = Set<String>()
        return Array(pins.filter { seen.insert($0).inserted }.prefix(max))
    }
}

/// The home's pinned stops, one page each in a card that swipes, then a
/// last page saying how to pin another.
enum BusPinned {
    /// The last page's id, beside the pinned stops' codes.
    static let addPage = "+"

    /// The page showing: `selected` while it's still there, else the first.
    static func page(_ pins: [String], selected: String?) -> String? {
        guard let first = pins.first else { return nil }
        if let selected, selected == addPage || pins.contains(selected) { return selected }
        return first
    }

    /// The page to show once the pins change from `old` to `new`: the same
    /// one while it's still there; one unpinned, the stop that took its place,
    /// or the one before it when it was the last; nil with none left.
    static func selection(old: [String], new: [String], selected: String?) -> String? {
        guard !new.isEmpty else { return nil }
        guard let selected, selected != addPage else { return selected }
        if new.contains(selected) { return selected }
        guard let i = old.firstIndex(of: selected) else { return new[0] }
        // The stops after it in `old` that are still pinned: the first takes its place.
        if let next = old[(i + 1)...].first(where: { new.contains($0) }) { return next }
        return new.last
    }

    /// The stop a page is about: its own, or the last pinned stop for the last page.
    static func focus(_ pins: [String], selected: String?) -> String? {
        let p = page(pins, selected: selected)
        return p == addPage ? pins.last : p
    }

    /// The stops asked for together: the one showing and the one either side,
    /// so a swipe to either has its buses already.
    static func window(_ pins: [String], selected: String?) -> [String] {
        guard let code = focus(pins, selected: selected), let i = pins.firstIndex(of: code) else { return [] }
        return Array(pins[max(0, i - 1)...min(pins.count - 1, i + 1)])
    }

    /// Of `window`, the stops not asked for within `gap` (`askedAt` says
    /// when each was), so going back and forth doesn't ask again at once; all
    /// of them when forced.
    static func toFetch(
        _ window: [String], now: Date, gap: TimeInterval, force: Bool = false, askedAt: (String) -> Date?
    ) -> [String] {
        force ? window : window.filter { askedAt($0).map { now.timeIntervalSince($0) >= gap } ?? true }
    }

    /// A pinned card's rows with its stop page's board, as Android's
    /// `PinnedStop.withBoard` and the web's `withBoard` make them. `card` is
    /// the card's own answer (/me/stops, never an earlier merge, whose guesses
    /// would come round again) and `since` the seconds since it came. Each of
    /// its rows, in its order, takes the board's row for the same service and
    /// way (`towards`), or the service's first left: the board's times, how
    /// full, running or not, still worded as /me/stops worded it ("via
    /// UTown"; the board has no such words), then the card's buses the board
    /// doesn't cover (`guessesAfter`). A row the board doesn't have counts down
    /// on its own, a live time turning stale. Public buses aren't the card's.
    static func filled(_ card: [BoardRow], from rows: [BoardRow], since: Int) -> [BoardRow] {
        var left = rows.filter { !$0.paid }
        return card.map { row in
            let i = left.firstIndex { $0.svc == row.svc && $0.towards == row.towards } ?? left.firstIndex { $0.svc == row.svc }
            guard let i else {
                guard let eta = row.etaS, since > 0 else { return row }
                var r = row
                let s = eta - since
                r.etaS = s > -60 ? max(0, s) : nil
                r.eta = nil
                if row.quality == "live" { r.quality = "stale" }
                r.later = guessesAfter(row.later, since: since, shown: 0)
                r.laterText = nil
                return r
            }
            let b = left.remove(at: i)
            var r = b
            r.dest = row.dest
            r.destPlace = row.destPlace
            let mine = (row.etaS.map { [BoardRow.Later(etaS: $0, quality: row.quality, eta: nil)] } ?? []) + row.later
            r.later = b.later + guessesAfter(mine, since: since, shown: (b.etaS == nil ? 0 : 1) + b.later.count)
            r.laterText = nil
            return r
        }
    }

    /// The card's `buses` (next first) that a board showing `shown` buses for
    /// the service doesn't cover, `since` seconds on: those now due gone, the
    /// board's buses the next `shown` of the rest (counted, not matched by
    /// time: a bus running ahead of its guess is still that bus), and of what's
    /// left only the timetable guesses, worded again from the time left.
    static func guessesAfter(_ buses: [BoardRow.Later], since: Int, shown: Int) -> [BoardRow.Later] {
        let due = buses.map {
            var l = $0
            l.etaS -= since
            l.eta = nil
            return l
        }.filter { $0.etaS > 0 }
        return due.dropFirst(shown).filter { $0.quality == "scheduled" }
    }
}

/// What a failed request says about what it asked for.
enum BusAsk {
    /// Cancelled, not refused or unanswered: the page or session that asked
    /// went. Not a failure to show, and not counted as asked, so the next
    /// page to want it asks at once rather than after the 15 s tick.
    static func cancelled(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }
}

/// What one /me/stops request leaves behind, for the stops it asked for.
struct BusPinnedResult: Equatable {
    /// Answered.
    var answered: [String] = []
    /// The request failed: "couldn't reach".
    var failed: [String] = []
    /// Not in the answer: a stop the server doesn't know.
    var missing: [String] = []
    /// Not settled (the request was cancelled by a swipe): asked for again at once, not shown as failed.
    var askAgain: [String] = []

    /// `returned`: the codes in the answer, nil when the request failed.
    static func of(asked: [String], returned: [String]?, cancelled: Bool) -> BusPinnedResult {
        if cancelled { return BusPinnedResult(askAgain: asked) }
        guard let returned else { return BusPinnedResult(failed: asked) }
        let got = Set(returned.map { $0.uppercased() })
        return BusPinnedResult(
            answered: asked.filter { got.contains($0.uppercased()) }, missing: asked.filter { !got.contains($0.uppercased()) })
    }
}

/// The list of lines' counts: /api/lines's (`list`, counted at `listAsOf`),
/// with a newer count from a service's own page in its place (`pages`), so
/// going back from a page never shows an older count than the page did.
struct BusOuts: Equatable {
    struct Page: Equatable {
        let at: Date
        let count: LineCount
    }
    private(set) var list: [String: LineCount] = [:]
    private(set) var listAsOf = Date.distantPast
    private(set) var pages: [String: Page] = [:]

    /// By service, as the list shows them; nothing while the list itself has none.
    var shown: [String: LineCount] {
        guard !list.isEmpty else { return list }
        return list.merging(pages.filter { $0.value.at > listAsOf }.mapValues(\.count)) { $1 }
    }

    func listed(_ counts: [String: LineCount], asOf: Date) -> BusOuts {
        var o = self
        o.list = counts
        o.listAsOf = asOf
        return o
    }

    /// `svc`'s page counted `count` at `at`; an answer older than the one kept changes nothing.
    func paged(_ svc: String, _ count: LineCount?, at: Date) -> BusOuts {
        guard let count, pages[svc].map({ $0.at <= at }) ?? true else { return self }
        var o = self
        o.pages[svc] = Page(at: at, count: count)
        return o
    }
}

/// The list of lines: each one's name, where it goes, and its buses out.
enum BusLines {
    /// /api/lines reads every service from NUS: at most once a minute.
    static let pollS: TimeInterval = 60

    /// How long to wait before asking for the counts again, last asked at `last`.
    static func wait(last: Date?, now: Date) -> TimeInterval {
        guard let last else { return 0 }
        return min(pollS, max(0, pollS - now.timeIntervalSince(last)))
    }

    /// The line's name as the server words it ("Loop from KR Bus Ter"), else
    /// worded here for an older campus.
    static func name(_ r: BusCampus.Route, stopName: (String) -> String) -> String? {
        r.name ?? BusWords.route(r, name: stopName)
    }

    /// The green dot beside a count: buses out, counted from a new answer. A
    /// stale count isn't live, so it has its words alone.
    static func showsDot(_ c: LineCount) -> Bool { c.out > 0 && !c.stale }

    /// A row as VoiceOver reads it: "Bus D2, Loop from COM 3, via PGP, KR MRT, UTown, 3 out".
    static func spoken(svc: String, name: String?, via: String?, count: LineCount?) -> String {
        [L("Bus %@", svc), name, via, count?.outText].compactMap { $0 }.filter { !$0.isEmpty }
            .joined(separator: Lang.zh ? "，" : ", ")
    }
}

/// A search result: a stop opens its board, a service its line.
enum BusHit: Hashable {
    case service(String)
    /// `name` is the full name; `aliases` its short name, lower case, and its nicknames.
    case stop(code: String, name: String, services: [String], aliases: [String])

    var key: SearchRank.Key {
        switch self {
        case .service(let s): SearchRank.Key(kind: "service", code: s, label: s, aliases: [])
        case .stop(let code, let name, _, let aliases): SearchRank.Key(kind: "stop", code: code, label: name, aliases: aliases)
        }
    }

    /// "service:A1", "stop:COM3", as the shared search cases list them.
    var id: String {
        switch self {
        case .service(let s): "service:\(s)"
        case .stop(let code, _, _, _): "stop:\(code)"
        }
    }

    var isService: Bool { if case .service = self { true } else { false } }
}

enum BusSearch {
    /// At most this many results, as the destination search.
    static let max = 8

    /// What the search looks through, as the web builds it (busesTabIndex):
    /// every service in code order, then every stop by its full name in
    /// /campus order, also found by its short name and its nicknames.
    static func index(_ c: BusCampus) -> [BusHit] {
        c.services.map { BusHit.service($0) }
            + c.stops.map { s in
                .stop(code: s.code, name: s.fullName, services: s.services, aliases: [s.name.lowercased()] + (c.aliases[s.code] ?? []))
            }
    }

    /// The tab's search by the destination search's rules; with nothing typed,
    /// the suggestions: every service, in order, not limited.
    static func search(_ query: String, in index: [BusHit], max: Int = max) -> [BusHit] {
        if query.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))).isEmpty {
            return index.filter(\.isService)
        }
        return SearchRank.rank(index, query, max: max) { $0.key }
    }
}

/// A line as it's drawn, top to bottom: every stop with the buses at it,
/// and between two stops a row for the buses on the way.
enum BusLineItem: Identifiable {
    case stop(index: Int, stop: Line.Stop, buses: [Line.Bus], here: Bool)
    case between(after: Int, buses: [Line.Bus])

    var id: String {
        switch self {
        case .stop(let i, _, _, _): "s\(i)"
        case .between(let i, _): "b\(i)"
        }
    }

    static func of(_ line: Line) -> [BusLineItem] {
        var out: [BusLineItem] = []
        for (i, s) in line.stops.enumerated() {
            out.append(.stop(index: i, stop: s, buses: line.buses.filter { $0.at == i }, here: line.here?.index == i))
            let between = line.buses.filter { $0.at == nil && $0.after == i }
            if !between.isEmpty { out.append(.between(after: i, buses: between)) }
        }
        return out
    }
}

/// The words and orderings the board shows that aren't the server's.
enum BusWords {
    /// The services not running come after the ones that are, as the API sorts them.
    static func runningFirst(_ rows: [BoardRow]) -> [BoardRow] {
        rows.filter(\.running) + rows.filter { !$0.running }
    }

    /// The later buses a row shows, as many as the server words.
    static let thenMax = 2

    /// Where the bus is going, the row's bold line: the end of its line,
    /// "Ends here" at the end of it, or an older server's "to …".
    static func destination(_ r: BoardRow) -> String? {
        r.towards.last ?? (r.endsHere ? L("Ends here") : r.toText)
    }

    /// "Next stop Central Library", under the destination; nothing when the next stop is where it ends.
    static func nextStop(_ r: BoardRow) -> String? {
        r.towards.count > 1 ? L("Next stop %@", r.towards[0]) : nil
    }

    /// A time that's live, the green dot beside it in place of the word.
    static func isLive(_ r: BoardRow) -> Bool { r.etaS != nil && r.quality == "live" }

    /// A later bus is from the timetable while the next one isn't: the "then" line says so.
    static func laterScheduled(_ r: BoardRow) -> Bool {
        r.quality != "scheduled" && r.later.prefix(thenMax).contains { $0.quality == "scheduled" }
    }

    /// "then 12, ~20, 25 min", as the server words it; worked out here, from the later buses it gave, for an older server.
    static func then(_ r: BoardRow) -> String? {
        if let t = r.laterText { return t }
        let mins = r.later.sorted { $0.etaS < $1.etaS }.prefix(thenMax).map { "\(BusTimes.minutes($0.etaS))" }
        guard !mins.isEmpty else { return nil }
        let list = mins.joined(separator: L(", "))
        return laterScheduled(r) ? L("then %@ min, estimated", list) : L("then %@ min", list)
    }

    /// The services that stop within two hours, soonest first, once each:
    /// "Runs until 11:15 PM" only when it's worth knowing.
    static func endingSoon(_ rows: [BoardRow], now: Date, within: TimeInterval = 2 * 3600) -> [(svc: String, at: Date)] {
        var seen = Set<String>()
        return rows.compactMap { r -> (svc: String, at: Date)? in
            guard let at = r.endsAt.flatMap(parseISODate), at > now, at.timeIntervalSince(now) <= within else { return nil }
            return (r.svc, at)
        }
        .sorted { $0.at < $1.at }
        .filter { seen.insert($0.svc).inserted }
    }

    /// "Updated just now" for the first few seconds, as the web app says, never "0 s ago".
    static func updated(_ asOf: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(asOf)))
        if s < 5 { return L("Updated just now") }
        if s < 60 { return L("Updated %@ s ago", "\(s)") }
        return L("Updated %@ min ago", "\(s / 60)")
    }

    /// A time as VoiceOver says it: "about 6 minutes", not "tilde 6 min".
    static func spoken(_ etaS: Int?, quality: String) -> String? {
        guard let s = etaS else { return nil }
        // An estimate is never "Arriving": about a minute, however close.
        if s < BusTimes.arrivingS && quality == "live" { return L("Arriving") }
        let m = BusTimes.minutes(s)
        let mins = m == 1 ? L("1 minute") : L("%@ minutes", "\(m)")
        return quality == "live" ? mins : L("about %@", mins)
    }

    /// Where a service goes, as the web app says under its name on its line:
    /// "Loop from COM 3", "Kent Vale to Prince George's Park". `name` gives a
    /// stop's name as people say it (its long name), as the web and Android do.
    static func route(_ r: BusCampus.Route, name: (String) -> String) -> String? {
        guard let first = r.seq.first, let last = r.seq.last else { return nil }
        return r.loop ? L("Loop from %@", name(first)) : L("%@ to %@", name(first), name(last))
    }

    /// How many buses a line has out.
    static func running(_ line: Line) -> String {
        if !line.available { return L("Live buses aren't available right now.") }
        switch line.buses.count {
        case 0: return L("No buses running")
        case 1: return L("1 bus running")
        case let n: return L("%@ buses running", "\(n)")
        }
    }
}
