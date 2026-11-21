import Foundation

enum BusRoute: Hashable {
    case stop(String)
    case line(svc: String, from: String?)
}

enum BusPins {
    static let defaultMax = 8

    static func toggle(_ pins: [String], _ code: String, max: Int = defaultMax) -> [String] {
        if pins.contains(code) { return pins.filter { $0 != code } }
        return pins.count >= max ? pins : pins + [code]
    }

    static func shown(_ pins: [String], max: Int = defaultMax) -> [String] {
        var seen = Set<String>()
        return Array(pins.filter { seen.insert($0).inserted }.prefix(max))
    }
}

enum BusPinned {
    static let addPage = "+"

    static func page(_ pins: [String], selected: String?) -> String? {
        guard let first = pins.first else { return nil }
        if let selected, selected == addPage || pins.contains(selected) { return selected }
        return first
    }

    static func selection(old: [String], new: [String], selected: String?) -> String? {
        guard !new.isEmpty else { return nil }
        guard let selected, selected != addPage else { return selected }
        if new.contains(selected) { return selected }
        guard let i = old.firstIndex(of: selected) else { return new[0] }
        if let next = old[(i + 1)...].first(where: { new.contains($0) }) { return next }
        return new.last
    }

    static func focus(_ pins: [String], selected: String?) -> String? {
        let p = page(pins, selected: selected)
        return p == addPage ? pins.last : p
    }

    static func window(_ pins: [String], selected: String?) -> [String] {
        guard let code = focus(pins, selected: selected), let i = pins.firstIndex(of: code) else { return [] }
        return Array(pins[max(0, i - 1)...min(pins.count - 1, i + 1)])
    }

    static func toFetch(
        _ window: [String], now: Date, gap: TimeInterval, force: Bool = false, askedAt: (String) -> Date?
    ) -> [String] {
        force ? window : window.filter { askedAt($0).map { now.timeIntervalSince($0) >= gap } ?? true }
    }

    static func filled(_ card: [BoardRow], from rows: [BoardRow], since: Int) -> [BoardRow] {
        var left = rows.filter { !$0.paid }
        var match = [BoardRow?](repeating: nil, count: card.count)
        for (k, row) in card.enumerated() {
            if let i = left.firstIndex(where: { $0.svc == row.svc && $0.towards == row.towards }) { match[k] = left.remove(at: i) }
        }
        for (k, row) in card.enumerated() where match[k] == nil {
            if let i = left.firstIndex(where: { $0.svc == row.svc }) { match[k] = left.remove(at: i) }
        }
        return zip(card, match).map { row, b in
            guard let b else {
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
            var r = row
            r.etaS = b.etaS
            r.quality = b.quality
            r.eta = b.eta
            r.crowd = b.crowd
            r.running = b.running
            r.stopped = b.stopped
            r.resumesAt = b.resumesAt
            let mine = (row.etaS.map { [BoardRow.Later(etaS: $0, quality: row.quality, eta: nil)] } ?? []) + row.later
            r.later = b.later + guessesAfter(mine, since: since, shown: (b.etaS == nil ? 0 : 1) + b.later.count)
            r.laterText = nil
            return r
        }
    }

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

enum BusAsk {
    static func cancelled(_ error: Error) -> Bool {
        error is CancellationError || (error as? URLError)?.code == .cancelled
    }
}

struct BusPinnedResult: Equatable {
    var answered: [String] = []
    var failed: [String] = []
    var missing: [String] = []
    var askAgain: [String] = []

    static func of(asked: [String], returned: [String]?, cancelled: Bool) -> BusPinnedResult {
        if cancelled { return BusPinnedResult(askAgain: asked) }
        guard let returned else { return BusPinnedResult(failed: asked) }
        let got = Set(returned.map { $0.uppercased() })
        return BusPinnedResult(
            answered: asked.filter { got.contains($0.uppercased()) }, missing: asked.filter { !got.contains($0.uppercased()) })
    }
}

struct BusOuts: Equatable {
    struct Page: Equatable {
        let at: Date
        let count: LineCount
    }
    private(set) var list: [String: LineCount] = [:]
    private(set) var listAsOf = Date.distantPast
    private(set) var pages: [String: Page] = [:]

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

    func paged(_ svc: String, _ count: LineCount?, at: Date) -> BusOuts {
        guard let count, pages[svc].map({ $0.at <= at }) ?? true else { return self }
        var o = self
        o.pages[svc] = Page(at: at, count: count)
        return o
    }
}

enum BusLines {
    static let pollS: TimeInterval = 60

    static func wait(last: Date?, now: Date) -> TimeInterval {
        guard let last else { return 0 }
        return min(pollS, max(0, pollS - now.timeIntervalSince(last)))
    }

    static func name(_ r: BusCampus.Route, stopName: (String) -> String) -> String? {
        r.name ?? BusWords.route(r, name: stopName)
    }

    static func showsDot(_ c: LineCount) -> Bool { c.out > 0 && !c.stale }

    static func spoken(svc: String, name: String?, via: String?, count: LineCount?) -> String {
        [L("Bus %@", svc), name, via, count?.outText].compactMap { $0 }.filter { !$0.isEmpty }
            .joined(separator: Lang.zh ? "，" : ", ")
    }
}

enum BusHit: Hashable {
    case service(String)
    case stop(code: String, name: String, services: [String], aliases: [String])

    var key: SearchRank.Key {
        switch self {
        case .service(let s): SearchRank.Key(kind: "service", code: s, label: s, aliases: [])
        case .stop(let code, let name, _, let aliases): SearchRank.Key(kind: "stop", code: code, label: name, aliases: aliases)
        }
    }

    var id: String {
        switch self {
        case .service(let s): "service:\(s)"
        case .stop(let code, _, _, _): "stop:\(code)"
        }
    }

    var isService: Bool { if case .service = self { true } else { false } }
}

enum BusSearch {
    static let max = 8

    static func index(_ c: BusCampus) -> [BusHit] {
        c.services.map { BusHit.service($0) }
            + c.stops.map { s in
                .stop(code: s.code, name: s.fullName, services: s.services, aliases: [s.name.lowercased()] + (c.aliases[s.code] ?? []))
            }
    }

    static func search(_ query: String, in index: [BusHit], max: Int = max) -> [BusHit] {
        if query.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "\u{FEFF}"))).isEmpty {
            return index.filter(\.isService)
        }
        return SearchRank.rank(index, query, max: max) { $0.key }
    }
}

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

enum BusWords {
    static func runningFirst(_ rows: [BoardRow]) -> [BoardRow] {
        rows.filter(\.running) + rows.filter { !$0.running }
    }

    static let thenMax = 2

    static func destination(_ r: BoardRow) -> String? {
        r.towards.last ?? (r.endsHere ? L("Ends here") : r.toText)
    }

    static func nextStop(_ r: BoardRow) -> String? {
        r.towards.count > 1 ? L("Next stop %@", r.towards[0]) : nil
    }

    static func isLive(_ r: BoardRow) -> Bool { r.etaS != nil && r.quality == "live" }

    static func laterScheduled(_ r: BoardRow) -> Bool {
        r.quality != "scheduled" && r.later.prefix(thenMax).contains { $0.quality == "scheduled" }
    }

    static func then(_ r: BoardRow) -> String? {
        if let t = r.laterText { return t }
        let mins = r.later.sorted { $0.etaS < $1.etaS }.prefix(thenMax).map { "\(BusTimes.minutes($0.etaS))" }
        guard !mins.isEmpty else { return nil }
        let list = mins.joined(separator: L(", "))
        return laterScheduled(r) ? L("then %@ min, estimated", list) : L("then %@ min", list)
    }

    static func endingSoon(_ rows: [BoardRow], now: Date, within: TimeInterval = 2 * 3600) -> [(svc: String, at: Date)] {
        var seen = Set<String>()
        return rows.compactMap { r -> (svc: String, at: Date)? in
            guard let at = r.endsAt.flatMap(parseISODate), at > now, at.timeIntervalSince(now) <= within else { return nil }
            return (r.svc, at)
        }
        .sorted { $0.at < $1.at }
        .filter { seen.insert($0.svc).inserted }
    }

    static func updated(_ asOf: Date, now: Date) -> String {
        let s = max(0, Int(now.timeIntervalSince(asOf)))
        if s < 5 { return L("Updated just now") }
        if s < 60 { return L("Updated %@ s ago", "\(s)") }
        return L("Updated %@ min ago", "\(s / 60)")
    }

    static func spoken(_ etaS: Int?, quality: String) -> String? {
        guard let s = etaS else { return nil }
        if s < BusTimes.arrivingS && quality == "live" { return L("Arriving") }
        let m = BusTimes.minutes(s)
        let mins = m == 1 ? L("1 minute") : L("%@ minutes", "\(m)")
        return quality == "live" ? mins : L("about %@", mins)
    }

    static func route(_ r: BusCampus.Route, name: (String) -> String) -> String? {
        guard let first = r.seq.first, let last = r.seq.last else { return nil }
        return r.loop ? L("Loop from %@", name(first)) : L("%@ to %@", name(first), name(last))
    }

    static func running(_ line: Line) -> String {
        if !line.available { return L("Live buses aren't available right now.") }
        switch line.buses.count {
        case 0: return L("No buses running")
        case 1: return L("1 bus running")
        case let n: return L("%@ buses running", "\(n)")
        }
    }
}
