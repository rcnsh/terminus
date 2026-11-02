import Foundation

/*
 * The Stops tab's rules, apart from its screens so they're unit tested
 * (Tests/BusesTests.swift), as Android's Buses.kt: the pins and the part of
 * each board the home shows, the search, a line as it's drawn, and the words
 * worked out here for an older server. Every time shown is one the API gave.
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

    /// The rows a pinned stop's board shows on the home, the running ones
    /// first, and how many more its own page has.
    static let homeRows = 3

    static func preview(_ rows: [BoardRow], max: Int = homeRows) -> (rows: [BoardRow], more: Int) {
        let all = runningFirst(rows)
        return (Array(all.prefix(max)), Swift.max(0, all.count - max))
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
        if s < BusTimes.arrivingS { return L("Arriving") }
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

extension PullOutcome {
    /// Several boards pulled at once, as one: updated if any came back, up
    /// to date if none needed asking (the soonest next update), else failed.
    static func combined(_ all: [PullOutcome]) -> PullOutcome {
        if all.contains(.updated) { return .updated }
        if all.contains(.failed) { return .failed }
        let next = all.compactMap { if case .upToDate(let s) = $0 { s } else { nil } }.min()
        return .upToDate(nextInS: next)
    }
}
