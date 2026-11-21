import SwiftUI

struct BusChip: View {
    let svc: String
    let color: String?
    var paid = false
    var big = false
    var width: CGFloat = 0
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        let rgb = color.flatMap(hexRGB) ?? 0x8A847E
        Text(verbatim: paid ? "\(svc) $" : svc)
            .font(.system(size: (big ? 20 : 15) * scale, weight: .heavy))
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(inkOn(rgb))
            .padding(.horizontal, 8)
            .frame(minWidth: max((big ? 64 : 46) * scale, width), minHeight: (big ? 44 : 32) * scale)
            .background(Color(rgb: rgb), in: RoundedRectangle(cornerRadius: big ? 12 : 9, style: .continuous))
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(paid ? L("Public bus %@, fare applies", svc) : L("Bus %@", svc))
    }
}

struct BusBoardCard: View {
    let board: Board?
    let failed: Bool
    let colors: [String: String]
    var services: [String] = []
    let onRow: (BoardRow) -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
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
                } else if failed {
                    message(L("Couldn't reach terminus. Check your connection and try again."))
                } else {
                    BoardSkeleton(services: services, colors: colors)
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

private struct BoardSkeleton: View {
    let services: [String]
    let colors: [String: String]
    @ScaledMetric(relativeTo: .largeTitle) private var scale: CGFloat = 1

    var body: some View {
        let rows: [String?] = services.isEmpty ? [nil, nil, nil] : services
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { i, svc in
                if i > 0 { Divider().overlay(Color.line) }
                HStack(alignment: .top, spacing: 12) {
                    if let svc {
                        BusChip(svc: svc, color: colors[svc])
                    } else {
                        SkeletonBar(width: 46, height: 32, radius: 9)
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        SkeletonLine(font: .body.bold(), fraction: SkeletonWidths.name(i))
                        SkeletonLine(font: .subheadline, fraction: SkeletonWidths.sub(i))
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    VStack(alignment: .trailing, spacing: 4) {
                        SkeletonLine(font: .system(size: 34 * scale, weight: .heavy), points: [58, 62, 66][i % 3])
                        SkeletonLine(font: .subheadline, points: 44)
                    }
                    .frame(minWidth: 72, alignment: .trailing)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.line)
                        .frame(maxHeight: .infinity)
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(.leading, 14)
                .padding(.trailing, 8)
                .padding(.vertical, 14)
            }
        }
        .shimmering()
        .skeletonSpoken()
    }
}

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

    @ViewBuilder private var runningRow: some View {
        if typeSize.isAccessibilitySize { stackedRow } else { sideBySideRow }
    }

    private var stackedRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                BusChip(svc: row.svc, color: color, paid: row.paid)
                Spacer(minLength: 8)
                time
                chevron
            }
            if let to = BusWords.destination(row) {
                Text(verbatim: to).font(.body).bold().foregroundStyle(Color.ink).fixedSize(horizontal: false, vertical: true)
            }
            if let next = BusWords.nextStop(row) {
                Text(verbatim: next).font(.subheadline).foregroundStyle(Color.muted).fixedSize(horizontal: false, vertical: true)
            }
            BusFlow(spacing: 8) { tags }
            if let t = BusWords.then(row) {
                Text(verbatim: t).font(.subheadline).foregroundStyle(Color.muted).accessibilityLabel(spokenTimes(t))
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 14)
    }

    private var sideBySideRow: some View {
        HStack(alignment: .top, spacing: 12) {
            BusChip(svc: row.svc, color: color, paid: row.paid)
            VStack(alignment: .leading, spacing: 4) {
                if let to = BusWords.destination(row) {
                    Text(verbatim: to).font(.body).bold().foregroundStyle(Color.ink).lineLimit(1)
                }
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        nextStop.fixedSize()
                        tags
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        nextStop.lineLimit(2)
                        BusFlow(spacing: 8) { tags }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            VStack(alignment: .trailing, spacing: 4) {
                time
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
    }

    private var time: some View {
        HStack(spacing: 6) {
            if BusWords.isLive(row) { BusLiveDot() }
            BusBigTime(etaS: row.etaS, quality: row.quality, eta: row.eta)
        }
    }

    @ViewBuilder private var nextStop: some View {
        if let next = BusWords.nextStop(row) { Text(verbatim: next).font(.subheadline).foregroundStyle(Color.muted) }
    }

    @ViewBuilder private var tags: some View {
        if !BusWords.isLive(row) { BusQualityTag(row: row) }
        if let c = busCrowdWord(row.crowd) { BusCrowdPill(text: c, packed: row.crowd == "high") }
    }

    private func stoppedRow(_ s: Stopped) -> some View {
        let (why, back) = s.lines
        return HStack(alignment: .center, spacing: 12) {
            BusChip(svc: row.svc, color: color, paid: row.paid)
            VStack(alignment: .leading, spacing: 2) {
                if !row.endsHere, let to = BusWords.destination(row) {
                    Text(verbatim: to)
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
}

extension Text {
    init(busBold part: String?, in text: String) {
        var a = AttributedString(text)
        if let part, !part.isEmpty, let r = a.range(of: part) { a[r].inlinePresentationIntent = .stronglyEmphasized }
        self.init(a)
    }
}

struct BusRowPress: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.background(configuration.isPressed ? Color.ink.opacity(0.06) : .clear)
    }
}

struct BusLiveDot: View {
    @Environment(\.inks) private var inks
    @ScaledMetric(relativeTo: .body) private var scale: CGFloat = 1

    var body: some View {
        ZStack {
            Circle().fill(inks.good.opacity(0.25)).frame(width: 10 * scale, height: 10 * scale)
            Circle().fill(inks.good).frame(width: 6 * scale, height: 6 * scale)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("Live"))
    }
}

struct BusQualityTag: View {
    let row: BoardRow
    @Environment(\.inks) private var inks

    var body: some View {
        if row.etaS == nil {
            Text(row.quality == "unknown" ? L("No live times") : L("No time yet"))
                .font(.subheadline.weight(.medium)).foregroundStyle(inks.muted)
        } else if row.quality == "live" {
            HStack(spacing: 6) {
                BusLiveDot().accessibilityHidden(true)
                Text(L("Live")).font(.subheadline.weight(.semibold)).foregroundStyle(inks.good)
            }
        } else if row.quality == "stale" {
            BusTag(text: L("Last known"), color: inks.muted)
        } else {
            BusTag(text: L("Estimate"), color: inks.warn)
        }
    }
}

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

struct BusBigTime: View {
    let etaS: Int?
    let quality: String
    let eta: String?
    var size: CGFloat = 34
    @ScaledMetric(relativeTo: .largeTitle) private var scale: CGFloat = 1

    var body: some View {
        let size = self.size * scale
        let arriving = (etaS ?? .max) < BusTimes.arrivingS && quality == "live"
        let color: Color = arriving ? .brand : (quality == "live" ? .ink : .muted)
        Group {
            if let etaS {
                big(eta ?? BusTimes.words(etaS, quality: quality), size: size).foregroundStyle(color)
            } else {
                Text(verbatim: "–").font(.system(size: 28 * scale, weight: .bold)).foregroundStyle(Color.faint)
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .accessibilityLabel(BusWords.spoken(etaS, quality: quality) ?? "")
    }

    private func big(_ s: String, size: CGFloat) -> Text {
        guard let r = s.range(of: #"\d+"#, options: .regularExpression) else {
            return Text(verbatim: s).font(.system(size: size, weight: .heavy))
        }
        let small = Font.system(size: 15 * scale, weight: .semibold)
        return Text(verbatim: String(s[..<r.lowerBound])).font(small)
            + Text(verbatim: String(s[r])).font(.system(size: size, weight: .heavy))
            + Text(verbatim: String(s[r.upperBound...])).font(small)
    }
}

struct BusBoardFoot: View {
    let board: Board

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { _ in
            let now = ServerClock.now
            let live = board.aged(now).rows.contains { $0.running && BusWords.isLive($0) }
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(BusWords.endingSoon(board.rows.filter(\.running), now: now), id: \.svc) { e in
                        Text(busBold: e.svc, in: L("%@ runs until %@", e.svc, campusTime(e.at))).font(.subheadline).foregroundStyle(
                            Color.ink)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if let asOf = board.asOf {
                    HStack(spacing: 6) {
                        if live { BusLiveDot().accessibilityHidden(true) }
                        Text(verbatim: (live ? L("Live") + " · " : "") + BusWords.updated(asOf, now: now))
                            .font(.subheadline).foregroundStyle(Color.muted).monospacedDigit()
                    }
                }
            }
            .padding(.horizontal, 4)
        }
    }
}
