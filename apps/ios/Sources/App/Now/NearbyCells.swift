import CoreGraphics
import Foundation

/// One bus in a Nearby column, as on a stop's board: the figures large and
/// the words small. Only the Next column carries the unit ("4 min",
/// "6:02 PM"); Then and After only their figures ("16", "~28"), with AM/PM
/// where the day's half changes, as a printed timetable does. An estimate is
/// marked "~" in both languages: in a column of figures a word ("约") reads
/// as part of the next. The first bus you can catch is the large one
/// (`pick`), in whichever column. One too soon to catch is struck through
/// once, as one run of text. A dash with no bus. As the web's NearbyTime.
struct NearbyCell: Equatable {
    /// "~" for an estimate, else empty.
    var mark = ""
    /// Small, before the figures: 下午 in Chinese 12-hour time.
    var lead = ""
    /// The figures: "4", "6:02"; "now" as the server words it; "–" with no bus.
    var figure = "–"
    /// Small, after the figures: " min", " PM".
    var trail = ""
    /// Due before you could walk to the stop.
    var struck = false
    /// The first bus you can catch.
    var pick = false
    /// How VoiceOver says the time alone ("about 6:02 PM, too soon to catch"); empty with no bus.
    var spoken = ""

    var hasBus: Bool { !spoken.isEmpty }
    /// The whole cell as one run of text, as a struck one is drawn.
    var text: String { mark + lead + figure + trail }
}

/// What a Nearby row says: its three buses' cells, where it's going, how
/// it's read out, and what the foot under the signs explains.
enum NearbyCells {
    /// A bus in a row: the row's own, or one of its `later`.
    struct Bus: Equatable {
        let etaS: Int
        let quality: String
        let words: String
        let at: String?
        let tooSoon: Bool

        var approx: Bool { quality == "scheduled" || quality == "stale" }
    }

    /// The row's three buses (`[row, later[0], later[1]]`), nil where there's none.
    static func buses(_ row: BoardRow) -> [Bus?] {
        let first = row.etaS.map {
            Bus(
                etaS: $0, quality: row.quality, words: row.etaText ?? BusTimes.words($0, quality: row.quality), at: row.at,
                tooSoon: row.tooSoon)
        }
        let later = row.later.prefix(2).map { Bus(etaS: $0.etaS, quality: $0.quality, words: $0.etaText, at: $0.at, tooSoon: $0.tooSoon) }
        return (0..<3).map { $0 == 0 ? first : ($0 - 1 < later.count ? later[$0 - 1] : nil) }
    }

    /// Which of the buses is the one to catch: the first with a time that isn't too soon.
    static func pick(_ buses: [Bus?]) -> Int? { buses.firstIndex { $0.map { !$0.tooSoon } ?? false } }

    /// The row's three cells. `clock` writes a time as the account has it
    /// (12- or 24-hour, the language's AM/PM), passed in for the tests.
    static func cells(_ row: BoardRow, asClock: Bool, clock: (Date) -> String = campusTime) -> [NearbyCell] {
        let all = buses(row)
        let p = pick(all)
        return all.indices.map { j in
            cell(all[j], prev: j > 0 ? all[j - 1] : nil, first: j == 0, pick: j == p, asClock: asClock, clock: clock)
        }
    }

    static func cell(_ bus: Bus?, prev: Bus?, first: Bool, pick: Bool, asClock: Bool, clock: (Date) -> String = campusTime) -> NearbyCell {
        guard let bus else { return NearbyCell() }
        var c = NearbyCell(mark: bus.approx ? "~" : "", struck: bus.tooSoon, pick: pick)
        if asClock, let d = bus.at.flatMap(parseISODate) {
            let (figure, half, before) = clockParts(clock(d))
            // AM/PM on Next, and after it only where the day's half changes from the cell before.
            let sayHalf = !half.isEmpty && (first || prev?.at.flatMap(parseISODate).map { clockParts(clock($0)).half != half } ?? true)
            c.figure = figure
            if sayHalf { if before { c.lead = half + "\u{00A0}" } else { c.trail = "\u{00A0}" + half } }
            c.spoken = Spoken.spell(c.mark + clock(d))
            // The one to catch says how long there is, as minutes would.
            if pick { c.spoken = L("%@, in %@", c.spoken, wait(bus)) }
        } else {
            // An older server's "now" for a guess: worded here instead, "~1 min", as the server words it now.
            let words =
                bus.approx && bus.words.range(of: #"\d"#, options: .regularExpression) == nil
                ? BusTimes.words(bus.etaS, quality: bus.quality) : bus.words
            if let r = words.range(of: #"\d+"#, options: .regularExpression) {
                c.figure = String(words[r])
                if first { c.trail = String(words[r.upperBound...]) }
            } else {
                // "now", "Arriving": no figures to set large, said as they are.
                c.mark = ""
                c.figure = words
            }
            // Live or estimated only for Next; Then and After have "about" for a guess.
            c.spoken = Spoken.eta(bus.etaS, quality: bus.quality, withQuality: first) ?? Spoken.spell(words)
        }
        if bus.tooSoon { c.spoken += L(", too soon to catch") }
        return c
    }

    /// How long until the one to catch, said after its clock time: "under a
    /// minute" for a bus seen at the stop, never "Arriving"; "about 1 minute"
    /// for a guess, however close.
    static func wait(_ bus: Bus) -> String {
        bus.quality == "live"
            ? Spoken.minutes(TimeInterval(bus.etaS)) : L("about %@", Spoken.minutes(TimeInterval(max(bus.etaS, 60))))
    }

    /// "6:02 PM" as its figures and the half of the day ("PM", "下午"), and
    /// whether the half comes first, as in Chinese. 24-hour time has no half.
    static func clockParts(_ whole: String) -> (figure: String, half: String, before: Bool) {
        guard let r = whole.range(of: #"[\d:]+"#, options: .regularExpression) else { return (whole, "", false) }
        let blank = CharacterSet.whitespaces.union(CharacterSet(charactersIn: "\u{00A0}"))
        let lead = whole[..<r.lowerBound].trimmingCharacters(in: blank)
        let trail = whole[r.upperBound...].trimmingCharacters(in: blank)
        return (String(whole[r]), lead.isEmpty ? trail : lead, !lead.isEmpty)
    }

    /// Where the row's bus is going as the server words it, split around the
    /// place ("via " + "UTown" + ""); the place is nil when there's none to
    /// set apart. An older server's end of the line otherwise.
    static func dest(_ row: BoardRow) -> (before: String, place: String?, after: String) {
        guard let dest = row.dest else {
            if let end = row.towards.last { return (L("to %@", end), nil, "") }
            return (row.toText ?? (row.endsHere ? L("Ends here") : ""), nil, "")
        }
        guard let place = row.destPlace, let r = dest.range(of: place) else { return (dest, nil, "") }
        return (String(dest[..<r.lowerBound]), place, String(dest[r.upperBound...]))
    }

    /// The destination in the narrowest two lines it can take, breaking at
    /// any space, a place's no-break ones too ("to KR" / "Bus Ter"): what it
    /// needs to fit in two lines at all. Keeping the place whole is drawn when
    /// there's room for it, never asked for.
    static func lines(_ row: BoardRow) -> [String] {
        let words: [String] = destText(row).components(separatedBy: CharacterSet(charactersIn: " \u{00A0}")).filter { !$0.isEmpty }
        guard words.count > 1 else { return words }
        let k = (1..<words.count).min { a, b in
            func longer(_ k: Int) -> Int {
                max(words[..<k].joined(separator: " ").count, words[k...].joined(separator: " ").count)
            }
            return longer(a) < longer(b)
        }!
        return [words[..<k].joined(separator: " "), words[k...].joined(separator: " ")]
    }

    /// The destination's two lines with its place whole on the second ("via" /
    /// "Kent Ridge MRT"), as it's drawn when there's room: what keeping the
    /// place together needs.
    static func wholeLines(_ row: BoardRow) -> [String] {
        let d = dest(row)
        guard let place = d.place else { return lines(row) }
        let before = d.before.trimmingCharacters(in: .whitespaces)
        return before.isEmpty ? [place + d.after] : [before, place + d.after]
    }

    static func destText(_ row: BoardRow) -> String {
        let d = dest(row)
        return d.before + (d.place ?? "") + d.after
    }

    /// The row as VoiceOver reads it: the line, where it's going, then each
    /// bus in order, the one to catch said so.
    static func spoken(_ row: BoardRow, cells: [NearbyCell]) -> String {
        var parts = [row.paid ? L("Public bus %@, fare applies", row.svc) : L("Bus %@", row.svc), destText(row)]
        for (j, c) in cells.enumerated() where c.hasBus {
            parts.append(c.pick ? L("next you can catch, %@", c.spoken) : j > 0 ? L("then %@", c.spoken) : c.spoken)
        }
        return parts.filter { !$0.isEmpty }.joined(separator: Lang.zh ? "，" : ", ")
    }

    /// Under the signs, once: what a struck-out time and a "~" mean, each
    /// only when one is showing, and that a row opens its line.
    static func foot(_ shown: [[NearbyCell]]) -> [String] {
        let all = shown.joined()
        var out: [String] = []
        if all.contains(where: \.struck) { out.append(L("Crossed out: you can't walk there in time.")) }
        if all.contains(where: { $0.mark == "~" }) { out.append(L("~ is a guess from the timetable, not a live time.")) }
        out.append(L("Tap a service to see its whole line."))
        return out
    }

    /// How the time columns are laid out on every sign at once.
    struct Layout: Equatable {
        /// Between the time columns.
        var between: CGFloat
        /// How much smaller than their own size the times are drawn (1: not at all).
        var zoom: CGFloat
        /// Each time column's width, the same on every row and heading.
        var widths: [CGFloat]
        /// Every row on two lines, badge and destination then its times, or none.
        var stacked: Bool
    }

    static let gap: CGFloat = 14
    static let tightGap: CGFloat = 8
    /// As small as the times are drawn before the rows go on two lines instead.
    static let minZoom: CGFloat = 0.85

    /// The time columns, for every card on screen at once, given each
    /// column's widest time and heading at full size, the most any row's
    /// destination needs in two lines (`lines`), `room` (a row's width less its
    /// badge and the gap to Next) and `line` (a row's whole width). What gives
    /// way, in order, measured: the gaps between the columns close from 14 to
    /// 8 pt; the times shrink, to 0.85 at most; then every row goes on two
    /// lines, its times at full size under it, so the columns still read
    /// straight down the page. A heading never shrinks.
    /// `whole`, what the widest destination needs to keep its place together,
    /// is asked for first; if that would stack the rows, only `need`, what it
    /// needs at all: a place kept whole is never a reason to stack.
    static func layout(times: [CGFloat], heads: [CGFloat], whole: CGFloat, need: CGFloat, room: CGFloat, line: CGFloat) -> Layout {
        let keep = layout(times: times, heads: heads, need: whole, room: room, line: line)
        return keep.stacked ? layout(times: times, heads: heads, need: need, room: room, line: line) : keep
    }

    static func layout(times: [CGFloat], heads: [CGFloat], need: CGFloat, room: CGFloat, line: CGFloat) -> Layout {
        // Up to the point, less a hair of floating-point error (44.000001 is 44).
        func widths(_ z: CGFloat) -> [CGFloat] { zip(times, heads).map { max(($0 * z - 0.001).rounded(.up), ($1 - 0.001).rounded(.up)) } }
        func fits(_ g: CGFloat, _ z: CGFloat) -> Bool { need + widths(z).reduce(0, +) + 2 * g <= room }
        for g in [gap, tightGap] where fits(g, 1) { return Layout(between: g, zoom: 1, widths: widths(1), stacked: false) }
        // The largest zoom that fits, a hundredth at a time.
        for z in stride(from: 99, through: Int(minZoom * 100), by: -1).map({ CGFloat($0) / 100 }) where fits(tightGap, z) {
            return Layout(between: tightGap, zoom: z, widths: widths(z), stacked: false)
        }
        let full = widths(1)
        let between = full.reduce(0, +) + 2 * gap <= line ? gap : tightGap
        return Layout(between: between, zoom: 1, widths: full, stacked: true)
    }
}
