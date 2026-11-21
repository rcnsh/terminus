import CoreGraphics
import Foundation

struct NearbyCell: Equatable {
    var mark = ""
    var figure = "–"
    var trail = ""
    var pick = false
    var spoken = ""

    var hasBus: Bool { !spoken.isEmpty }
    var text: String { mark + figure + trail }
}

enum NearbyCells {
    struct Bus: Equatable {
        let etaS: Int
        let quality: String
        let words: String

        var approx: Bool { quality == "scheduled" || quality == "stale" }
    }

    static func buses(_ row: BoardRow) -> [Bus?] {
        let first = row.etaS.map { Bus(etaS: $0, quality: row.quality, words: row.etaText ?? BusTimes.words($0, quality: row.quality)) }
        let later = row.later.prefix(2).map { Bus(etaS: $0.etaS, quality: $0.quality, words: $0.etaText) }
        return (0..<3).map { $0 == 0 ? first : ($0 - 1 < later.count ? later[$0 - 1] : nil) }
    }

    static func cells(_ row: BoardRow) -> [NearbyCell] {
        let all = buses(row)
        return all.indices.map { cell(all[$0], first: $0 == 0) }
    }

    static func cell(_ bus: Bus?, first: Bool) -> NearbyCell {
        guard let bus else { return NearbyCell() }
        var c = NearbyCell(mark: bus.approx ? "~" : "", pick: first)
        let words =
            bus.approx && bus.words.range(of: #"\d"#, options: .regularExpression) == nil
            ? BusTimes.words(bus.etaS, quality: bus.quality) : bus.words
        if let r = words.range(of: #"\d+"#, options: .regularExpression) {
            c.figure = String(words[r])
            if first { c.trail = String(words[r.upperBound...]) }
        } else {
            c.mark = ""
            c.figure = words
        }
        c.spoken = Spoken.eta(bus.etaS, quality: bus.quality, withQuality: first) ?? Spoken.spell(words)
        return c
    }

    static func dest(_ row: BoardRow) -> (before: String, place: String?, after: String) {
        guard let dest = row.dest else {
            if let end = row.towards.last { return (L("to %@", end), nil, "") }
            return (row.toText ?? (row.endsHere ? L("Ends here") : ""), nil, "")
        }
        guard let place = row.destPlace, let r = dest.range(of: place) else { return (dest, nil, "") }
        return (String(dest[..<r.lowerBound]), place, String(dest[r.upperBound...]))
    }

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

    static func spoken(_ row: BoardRow, cells: [NearbyCell]) -> String {
        var parts = [row.paid ? L("Public bus %@, fare applies", row.svc) : L("Bus %@", row.svc), destText(row)]
        for (j, c) in cells.enumerated() where c.hasBus {
            parts.append(j > 0 ? L("then %@", c.spoken) : c.spoken)
        }
        return parts.filter { !$0.isEmpty }.joined(separator: Lang.zh ? "，" : ", ")
    }

    static func foot(_ shown: [[NearbyCell]]) -> String? {
        shown.joined().contains(where: { $0.mark == "~" }) ? L("~ is a guess from the timetable, not a live time.") : nil
    }

    struct Layout: Equatable {
        var between: CGFloat
        var zoom: CGFloat
        var widths: [CGFloat]
        var stacked: Bool
    }

    static let gap: CGFloat = 14
    static let tightGap: CGFloat = 8
    static let minZoom: CGFloat = 0.85

    static func layout(times: [CGFloat], heads: [CGFloat], whole: CGFloat, need: CGFloat, room: CGFloat, line: CGFloat) -> Layout {
        let keep = layout(times: times, heads: heads, need: whole, room: room, line: line)
        return keep.stacked ? layout(times: times, heads: heads, need: need, room: room, line: line) : keep
    }

    static func layout(times: [CGFloat], heads: [CGFloat], need: CGFloat, room: CGFloat, line: CGFloat) -> Layout {
        func widths(_ z: CGFloat) -> [CGFloat] { zip(times, heads).map { max(($0 * z - 0.001).rounded(.up), ($1 - 0.001).rounded(.up)) } }
        func fits(_ g: CGFloat, _ z: CGFloat) -> Bool { need + widths(z).reduce(0, +) + 2 * g <= room }
        for g in [gap, tightGap] where fits(g, 1) { return Layout(between: g, zoom: 1, widths: widths(1), stacked: false) }
        for z in stride(from: 99, through: Int(minZoom * 100), by: -1).map({ CGFloat($0) / 100 }) where fits(tightGap, z) {
            return Layout(between: tightGap, zoom: z, widths: widths(z), stacked: false)
        }
        let full = widths(1)
        let between = full.reduce(0, +) + 2 * gap <= line ? gap : tightGap
        return Layout(between: between, zoom: 1, widths: full, stacked: true)
    }
}
