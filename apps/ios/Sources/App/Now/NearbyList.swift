import SwiftUI

/// The stops near you as their signs: the name plate with the walk there
/// and the stop's star, then a row per service read like a stop's board:
/// where it's going, its next bus and the one after, in minutes or as clock
/// times (the switch over the signs, kept on this phone). A bus due before
/// you could walk there is struck out. The nearest stop is drawn larger. The
/// plate opens the stop's board on the Stops tab, a row its service's line
/// from there; under the signs, a way to any other stop or line. As
/// Android's NearbyList and the web app.
struct NearbyList: View {
    @Environment(AppModel.self) private var app
    @State private var prefs = Prefs.shared

    var body: some View {
        if let stops = app.nearby {
            if stops.isEmpty {
                Text(L("Nothing yet")).foregroundStyle(Color.muted)
            }
            VStack(spacing: 12) {
                if !stops.isEmpty {
                    Picker(L("Show times"), selection: $prefs.nearbyClock) {
                        Text(L("In minutes")).tag(false)
                        Text(L("Clock time")).tag(true)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityLabel(L("Show times"))
                    .accessibilityIdentifier("nearbyTimes")
                }
                ForEach(Array(stops.enumerated()), id: \.element.id) { i, s in
                    let code = s.stop.code
                    StopSign(stop: s, big: i == 0, asClock: prefs.nearbyClock, onStop: { app.showInBuses([.stop(code)]) }) { svc in
                        app.showInBuses([.line(svc: svc, from: code)])
                    }
                }
                StopsLink { app.showInBuses([]) }
            }
            // The stars need the account's pins, which the Stops tab keeps.
            .task(id: app.session) {
                BusesModel.shared.sync()
                await BusesModel.shared.loadProfile()
            }
        } else {
            Text(app.loading ? L("Checking…") : L("Nothing yet")).font(.title3)
        }
    }
}

private struct StopSign: View {
    /// Follows the text size the phone is set to, as the rest of the card does.
    @ScaledMetric(relativeTo: .title) private var scale: CGFloat = 1
    let stop: NearbyStop
    let big: Bool
    let asClock: Bool
    let onStop: () -> Void
    let onRow: (String) -> Void

    private var walk: String { stop.walkS < 60 ? L("here") : L("%@ min walk", "\((stop.walkS + 30) / 60)") }

    /// The columns, the same on every sign and its heading so the times line
    /// up down the page; clock times ("12:05 PM") need more room than minutes.
    private var svcW: CGFloat { 52 }
    private var nextW: CGFloat { (asClock ? 92 : 72) * scale }
    private var thenW: CGFloat { (asClock ? 80 : 62) * scale }

    var body: some View {
        VStack(spacing: 0) {
            // The plate, as on the pole: a shade off the card, the bus mark in the accent.
            HStack(spacing: 0) {
                Button(action: onStop) {
                    HStack(spacing: 8) {
                        Image(systemName: "bus.fill").font(.system(size: (big ? 15 : 13) * scale)).foregroundStyle(Color.brand)
                        Text(stop.stop.name).font(.system(size: (big ? 17 : 15) * scale, weight: .bold)).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(walk)
                            .font(.subheadline.weight(.medium))
                            .foregroundStyle(Color.muted)
                    }
                    .padding(.leading, 14)
                    .frame(maxHeight: .infinity)
                    .contentShape(Rectangle())
                }
                .buttonStyle(BusRowPress())
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(stop.stop.name), \(walk)")
                .accessibilityHint(L("See this stop's buses"))
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("nearby.\(stop.stop.code)")
                // Only once the pins have come: before, a pinned stop's star would
                // read hollow, and a tap on it would unpin it.
                if BusesModel.shared.pinsState == .ready {
                    BusStar(code: stop.stop.code, name: stop.stop.name).padding(.trailing, 2)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            .frame(minHeight: big ? 46 : 38)
            .background(Color.surface2)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.line).frame(height: 1) }

            if !stop.available {
                Text(L("No live data")).foregroundStyle(Color.muted).padding(14).frame(maxWidth: .infinity, alignment: .leading)
            }
            // Running now: the board comes with the rest too, for the widgets' first buses.
            let rows = stop.board.filter(\.running)
            if !rows.isEmpty {
                HStack(spacing: 10) {
                    Spacer(minLength: svcW)
                    Text(L("Next bus")).frame(width: nextW, alignment: .trailing)
                    Text(L("Then")).frame(width: thenW, alignment: .trailing)
                }
                .font(.caption2.weight(.semibold))
                .textCase(.uppercase)
                .tracking(0.6)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .foregroundStyle(Color.muted)
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .accessibilityHidden(true)
            }
            ForEach(Array(rows.enumerated()), id: \.offset) { j, row in
                if j > 0 { Rectangle().fill(Color.line).frame(height: 1) }
                let next = NearbyTime.of(row, asClock: asClock)
                let then = row.later.first.flatMap { NearbyTime.of($0, asClock: asClock) }
                // A public bus has no line here (/line is the shuttles'), as on a board.
                Button {
                    onRow(row.svc)
                } label: {
                    HStack(spacing: 10) {
                        BusBadge(svc: row.svc, color: row.color, size: big ? 13 : 12, paid: row.paid)
                            .frame(width: svcW, alignment: .leading)
                        Text(NearbyTime.towards(row))
                            .font(.footnote)
                            .foregroundStyle(Color.muted)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        time(next)
                            .font(.system(size: (big ? 18 : 15) * scale, weight: .heavy))
                            .frame(width: nextW, alignment: .trailing)
                        time(then, color: .muted)
                            .font(.system(size: 14 * scale, weight: .semibold))
                            .frame(width: thenW, alignment: .trailing)
                    }
                    .padding(.horizontal, 14)
                    .padding(.vertical, big ? 10 : 7)
                    .contentShape(Rectangle())
                }
                .buttonStyle(BusRowPress())
                .disabled(row.paid)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    [
                        row.paid ? L("Public bus %@, fare applies", row.svc) : L("Bus %@", row.svc),
                        NearbyTime.towards(row),
                        next?.spoken,
                        then.map { L("then %@", $0.spoken) },
                    ]
                    .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
                )
                .accessibilityHint(row.paid ? "" : L("See the %@ line", row.svc))
                .accessibilityAddTraits(row.paid ? [] : .isButton)
                .accessibilityIdentifier("nearbyRow.\(stop.stop.code).\(row.svc)")
            }
        }
        .foregroundStyle(Color.ink)
        .background(Color.surface)
        .clipShape(RoundedRectangle(cornerRadius: big ? 18 : 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: big ? 18 : 14, style: .continuous).strokeBorder(Color.line))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(stop.stop.name), \(walk)")
    }

    /// A bus's time in its column, or a dash with none; struck out and faint when it's too soon to catch.
    private func time(_ t: NearbyTime?, color: Color = .ink) -> some View {
        Text(t?.text ?? "–")
            .monospacedDigit()
            .strikethrough(t?.tooSoon == true, color: .faint)
            .foregroundStyle(t?.tooSoon == true ? Color.faint : color)
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }
}

/// One bus in a Nearby column, as the web's NearbyTime: the server's words
/// ("4 min", "~6 min") or its clock time ("~12:05 PM" for an estimate), how
/// it's said, and whether it's too soon to catch.
struct NearbyTime: Equatable {
    let text: String
    let spoken: String
    let tooSoon: Bool

    /// A row's next bus; nil with none.
    static func of(_ row: BoardRow, asClock: Bool) -> NearbyTime? {
        guard let s = row.etaS else { return nil }
        return of(
            etaS: s, words: row.etaText ?? BusTimes.words(s, quality: row.quality), quality: row.quality, at: row.at, tooSoon: row.tooSoon,
            asClock: asClock)
    }

    /// A bus after a row's next.
    static func of(_ bus: BoardRow.Later, asClock: Bool) -> NearbyTime {
        of(etaS: bus.etaS, words: bus.etaText, quality: bus.quality, at: bus.at, tooSoon: bus.tooSoon, asClock: asClock)
    }

    static func of(etaS: Int, words: String, quality: String, at: String?, tooSoon: Bool, asClock: Bool) -> NearbyTime {
        var text = words
        var spoken = Spoken.eta(etaS, quality: quality) ?? Spoken.spell(words)
        if asClock, let d = at.flatMap(parseISODate) {
            let approx = quality == "scheduled" || quality == "stale"
            text = approx ? L("~%@", campusTime(d)) : campusTime(d)
            spoken = Spoken.spell(text)
        }
        if tooSoon { spoken += L(", too soon to catch") }
        return NearbyTime(text: text, spoken: spoken, tooSoon: tooSoon)
    }

    /// Where a row's bus is going, "to Kent Ridge MRT", or that this is the end of its line.
    static func towards(_ row: BoardRow) -> String {
        if let end = row.towards.last { return L("to %@", end) }
        return row.toText ?? (row.endsHere ? L("Ends here") : "")
    }
}

/// Under the signs: what the Stops tab is for, and the way there.
private struct StopsLink: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Image("StopSign").renderingMode(.template).foregroundStyle(Color.brand).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Another stop, or a whole line")).font(.body.weight(.semibold)).foregroundStyle(Color.ink)
                    Text(L("Search, pinned stops and services are in Stops.")).font(.subheadline).foregroundStyle(Color.muted)
                }
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint).accessibilityHidden(true)
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(BusRowPress())
        .background(Color.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.line))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("nearbyStops")
    }
}
