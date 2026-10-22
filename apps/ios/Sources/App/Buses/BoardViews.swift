import SwiftUI

/*
 * A stop's board, as the Android app draws it (BusesScreen.kt): a card with
 * a row per service, its colour chip, where it goes, Live or Scheduled and
 * how full it is, and the minutes large on the right. A service not running
 * is greyed, with why and when it's back. Every time is the server's.
 */

/// A service as it's painted on the bus, larger, for the board's rows and the line's heading.
struct BusChip: View {
    let svc: String
    let color: String?
    var paid = false
    var big = false
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        let rgb = color.flatMap(hexRGB) ?? 0x8A847E
        Text(verbatim: paid ? "\(svc) $" : svc)
            .font(.system(size: (big ? 20 : 15) * scale, weight: .heavy))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(inkOn(rgb))
            .padding(.horizontal, 8)
            .frame(minWidth: (big ? 64 : 46) * scale, minHeight: (big ? 44 : 32) * scale)
            .background(Color(rgb: rgb), in: RoundedRectangle(cornerRadius: big ? 12 : 9, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(paid ? L("Public bus %@, fare applies", svc) : L("Bus %@", svc))
    }
}

/// The board: a row per service, the running ones first.
struct BusBoardCard: View {
    let board: Board?
    let failed: Bool
    let colors: [String: String]
    let onRow: (BoardRow) -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            // Refreshes failing: the times counted down, none passed off as live.
            let now = ServerClock.now
            let b = board?.aged(now)
            VStack(alignment: .leading, spacing: 0) {
                if let b {
                    if b.rows.isEmpty {
                        message(b.available ? L("No buses are running here now") : L("Live times aren't available right now."))
                    } else {
                        if !b.available {
                            message(L("Live times aren't available right now."))
                            Divider().overlay(Color.line)
                        }
                        let rows = BusWords.runningFirst(b.rows)
                        ForEach(Array(rows.enumerated()), id: \.offset) { i, row in
                            if i > 0 { Divider().overlay(Color.line) }
                            BusBoardRowView(row: row, color: row.color ?? colors[row.svc], now: now, onTap: row.paid ? nil : { onRow(row) })
                        }
                    }
                } else {
                    message(failed ? L("Couldn't reach terminus. Check your connection and try again.") : L("Checking…"))
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        }
    }

    private func message(_ text: String) -> some View {
        Text(text).foregroundStyle(Color.muted).padding(16).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One service at the stop. A public bus has no line page (/line is the shuttles'), so no chevron.
struct BusBoardRowView: View {
    let row: BoardRow
    let color: String?
    let now: Date
    let onTap: (() -> Void)?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        let stopped = Stopped.of(running: row.running, why: row.stopped, resumesAt: row.resumesAt, now: now)
        Button {
            onTap?()
        } label: {
            Group {
                if let stopped { stoppedRow(stopped) } else { runningRow }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(BusRowPress())
        .disabled(onTap == nil)
        .accessibilityHint(onTap == nil ? "" : L("See the %@ line", row.svc))
        .accessibilityIdentifier("board-row-\(row.svc)")
    }

    private var arriving: Bool { (row.etaS ?? .max) < BusTimes.arrivingS }

    @ViewBuilder private var runningRow: some View {
        if typeSize.isAccessibilitySize { stackedRow } else { sideBySideRow }
    }

    /// At the largest text sizes there's no room beside the words for the
    /// minutes: they go on the chip's line, the rest under it.
    private var stackedRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                BusChip(svc: row.svc, color: color, paid: row.paid)
                Spacer(minLength: 8)
                BusBigTime(etaS: row.etaS, quality: row.quality, eta: row.eta)
                chevron
            }
            if let to = towards { to.font(.body).foregroundStyle(Color.ink).fixedSize(horizontal: false, vertical: true) }
            BusFlow(spacing: 8) {
                BusQualityTag(row: row)
                if let c = busCrowdWord(row.crowd) { BusCrowdPill(text: c, packed: row.crowd == "high") }
            }
            if let t = BusWords.then(row) {
                Text(verbatim: t).font(.subheadline).foregroundStyle(Color.muted).accessibilityLabel(spokenTimes(t))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
        .background(arriving ? Color.brandSoft : Color.clear)
    }

    private var sideBySideRow: some View {
        HStack(alignment: .top, spacing: 12) {
            BusChip(svc: row.svc, color: color, paid: row.paid)
            VStack(alignment: .leading, spacing: 6) {
                if let to = towards { to.font(.body).foregroundStyle(Color.ink).lineLimit(2).fixedSize(horizontal: false, vertical: true) }
                HStack(spacing: 8) {
                    BusQualityTag(row: row)
                    if let c = busCrowdWord(row.crowd) { BusCrowdPill(text: c, packed: row.crowd == "high") }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 4) {
                BusBigTime(etaS: row.etaS, quality: row.quality, eta: row.eta)
                if let t = BusWords.then(row) {
                    Text(verbatim: t).font(.subheadline).foregroundStyle(Color.muted).multilineTextAlignment(.trailing)
                        .accessibilityLabel(spokenTimes(t))
                }
            }
            .frame(minWidth: 72, alignment: .trailing)
            chevron
        }
        .padding(.leading, 14)
        .padding(.trailing, onTap == nil ? 14 : 8)
        .padding(.vertical, 14)
        // Due within the minute: tinted, as on Android.
        .background(arriving ? Color.brandSoft : Color.clear)
    }

    private func stoppedRow(_ s: Stopped) -> some View {
        let (why, back) = s.lines
        return HStack(alignment: .center, spacing: 12) {
            BusChip(svc: row.svc, color: color, paid: row.paid).opacity(0.35)
            VStack(alignment: .leading, spacing: 2) {
                if !row.towards.isEmpty {
                    // Whole at the largest text sizes, where one line holds a stop's name at most.
                    Text(verbatim: row.toText ?? L("to %@", row.towards.joined(separator: L(", "))))
                        .font(.subheadline).foregroundStyle(Color.muted).lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }
                Text(why).font(.body.weight(.semibold)).foregroundStyle(Color.muted)
                if let back { Text(back).font(.subheadline).foregroundStyle(Color.muted) }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            chevron
        }
        .padding(.leading, 14)
        .padding(.trailing, onTap == nil ? 14 : 8)
        .padding(.vertical, 12)
    }

    @ViewBuilder private var chevron: some View {
        if onTap != nil {
            Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint)
                .frame(maxHeight: typeSize.isAccessibilitySize ? nil : .infinity).fixedSize(horizontal: true, vertical: false)
                .accessibilityHidden(true)
        }
    }

    /// The server's "to Central Library, Kent Vale" with the next stop in bold; all of it at the end of the line.
    private var towards: Text? {
        if let t = row.toText {
            if row.endsHere { return Text(verbatim: t).bold() }
            return Text(busBold: row.towards.first, in: t)
        }
        if !row.towards.isEmpty {
            let joined = row.towards.joined(separator: L(", "))
            return Text(busBold: row.towards.first, in: L("to %@", joined))
        }
        if row.endsHere { return Text(L("Ends here")).bold() }
        return nil
    }
}

extension Text {
    /// `text` with the first `part` of it in bold.
    init(busBold part: String?, in text: String) {
        var a = AttributedString(text)
        if let part, !part.isEmpty, let r = a.range(of: part) { a[r].inlinePresentationIntent = .stronglyEmphasized }
        self.init(a)
    }
}

/// A row pressed: a faint wash, as a list's row.
struct BusRowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? Color.ink.opacity(0.06) : .clear)
    }
}

/// Live (a dot), Scheduled (amber), or the last time known; why there's no time when there isn't one.
struct BusQualityTag: View {
    let row: BoardRow
    @Environment(\.inks) private var inks

    var body: some View {
        if row.etaS == nil {
            Text(row.quality == "unknown" ? L("No live times") : L("No time yet"))
                .font(.subheadline.weight(.medium)).foregroundStyle(inks.muted)
        } else if row.quality == "live" {
            HStack(spacing: 6) {
                ZStack {
                    Circle().fill(inks.good.opacity(0.25)).frame(width: 10, height: 10)
                    Circle().fill(inks.good).frame(width: 6, height: 6)
                }
                Text(L("Live")).font(.subheadline.weight(.semibold)).foregroundStyle(inks.good)
            }
        } else if row.quality == "stale" {
            BusTag(text: L("Last known"), color: inks.muted)
        } else {
            BusTag(text: L("Estimate"), color: inks.warn)
        }
    }
}

/// Small words on a tint of their own colour.
struct BusTag: View {
    let text: String
    let color: Color
    var body: some View {
        Text(text).font(.subheadline.weight(.semibold)).foregroundStyle(color)
            .padding(.horizontal, 7).padding(.vertical, 2)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

struct BusCrowdPill: View {
    let text: String
    let packed: Bool
    var body: some View {
        Text(text).font(.subheadline).foregroundStyle(packed ? Color.warn : Color.muted)
            .padding(.horizontal, 9).padding(.vertical, 2)
            .background(packed ? Color.warn.opacity(0.12) : Color.surface2, in: Capsule())
    }
}

func busCrowdWord(_ crowd: String?) -> String? {
    switch crowd {
    case "low": L("Seats")
    case "medium": L("Busy")
    case "high": L("Packed")
    default: nil
    }
}

/// "4 min" with the number large, or "Arriving"; a dash without a time (the
/// tag says why). The words are the server's ("4 min", "~6 min", "约 6 分钟"),
/// with its number drawn large; worked out here for an older server.
struct BusBigTime: View {
    let etaS: Int?
    let quality: String
    let eta: String?
    /// The number's size at the default text size; it grows with the reader's.
    var size: CGFloat = 34
    @ScaledMetric(relativeTo: .largeTitle) private var scale: CGFloat = 1

    var body: some View {
        let size = self.size * scale
        let arriving = (etaS ?? .max) < BusTimes.arrivingS
        let color: Color = arriving ? .brand : (quality == "live" ? .ink : .muted)
        Group {
            if etaS == nil {
                Text(verbatim: "–").font(.system(size: 28 * scale, weight: .bold)).foregroundStyle(Color.faint)
            } else if let eta {
                big(eta, size: size).foregroundStyle(color)
            } else if arriving {
                Text(L("Arriving")).font(.system(size: 24 * scale, weight: .heavy)).foregroundStyle(Color.brand)
            } else {
                (Text(verbatim: "\(BusTimes.minutes(etaS ?? 0))").font(.system(size: size, weight: .heavy))
                    + Text(verbatim: " " + L("min")).font(.system(size: 15 * scale, weight: .semibold)))
                    .foregroundStyle(color)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .accessibilityLabel(BusWords.spoken(etaS, quality: quality) ?? "")
    }

    private func big(_ s: String, size: CGFloat) -> Text {
        guard let r = s.range(of: #"\d+"#, options: .regularExpression) else {
            return Text(verbatim: s).font(.system(size: 24 * scale, weight: .heavy))
        }
        let small = Font.system(size: 15 * scale, weight: .semibold)
        return Text(verbatim: String(s[..<r.lowerBound])).font(small)
            + Text(verbatim: String(s[r])).font(.system(size: size, weight: .heavy))
            + Text(verbatim: String(s[r.upperBound...])).font(small)
    }
}

/// Under the board: the services ending within two hours, and how old the times are.
struct BusBoardFoot: View {
    let board: Board

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = ServerClock.now
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(BusWords.endingSoon(board.rows.filter(\.running), now: now), id: \.svc) { e in
                            Text(busBold: e.svc, in: L("%@ runs until %@", e.svc, campusTime(e.at))).font(.subheadline).foregroundStyle(
                                Color.ink)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let asOf = board.asOf {
                        Text(BusWords.updated(asOf, now: now)).font(.subheadline).foregroundStyle(Color.muted).monospacedDigit()
                    }
                }
                if board.rows.contains(where: { !$0.paid }) {
                    Text(L("Tap a service to see its whole line.")).font(.footnote).foregroundStyle(Color.muted)
                }
            }
            .padding(.horizontal, 4)
        }
    }
}
