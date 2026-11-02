import SwiftUI

/// The stops near you as their signs: the name plate with the walk there
/// and the stop's star, then a row per service, its buses coming up a short
/// road towards the stop, nearer the sooner they're due, the next one solid
/// and the rest faded. The nearest stop is drawn larger. An estimate is an
/// outline, never a filled bus, so it doesn't pass for live. The plate opens
/// the stop's board on the Stops tab, a row its service's line from there;
/// under the signs, a way to any other stop or line. As Android's NearbyList
/// and the web app.
struct NearbyList: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let stops = app.nearby {
            if stops.isEmpty {
                Text(L("Nothing yet")).foregroundStyle(Color.muted)
            }
            VStack(spacing: 12) {
                ForEach(Array(stops.enumerated()), id: \.element.id) { i, s in
                    let code = s.stop.code
                    StopSign(stop: s, big: i == 0, onStop: { app.showInBuses([.stop(code)]) }) { svc in
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
    let onStop: () -> Void
    let onRow: (String) -> Void

    private var walk: String { stop.walkS < 60 ? L("here") : L("%@ min walk", "\((stop.walkS + 30) / 60)") }

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
            ForEach(Array(stop.board.filter(\.running).enumerated()), id: \.offset) { j, row in
                if j > 0 { Rectangle().fill(Color.line).frame(height: 1) }
                // A public bus has no line here (/line is the shuttles'), as on a board.
                Button {
                    onRow(row.svc)
                } label: {
                    HStack(spacing: 10) {
                        BusBadge(svc: row.svc, color: row.color, size: big ? 13 : 12, paid: row.paid)
                            .frame(width: row.paid ? 52 : 34, alignment: .leading)
                        BusRoad(row: row).frame(height: 18)
                        Text(row.etaText ?? "–")
                            .font(.system(size: (big ? 18 : 15) * scale, weight: .heavy))
                            .monospacedDigit()
                            .lineLimit(1)
                            .frame(minWidth: 56, alignment: .trailing)
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
                        Spoken.eta(row.etaS, quality: row.quality) ?? Spoken.spell(row.etaText ?? ""),
                    ].joined(separator: ", ")
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

/// A short road to the stop (the ring at its end), and the buses on it:
/// filled in their colour when the time is live, an outline when it's an
/// estimate; the next one solid, the ones after it faded.
/// How far up the road a bus is drawn: this many seconds away is the far end.
private let roadS = 15 * 60

private struct BusRoad: View {
    let row: BoardRow

    var body: some View {
        let color = serviceColor(row.color)
        Canvas { g, size in
            let y = size.height / 2
            let ring: CGFloat = 5
            let end = size.width - ring - 1
            var road = Path()
            road.move(to: CGPoint(x: 0, y: y))
            road.addLine(to: CGPoint(x: end, y: y))
            g.stroke(road, with: .color(.line), style: StrokeStyle(lineWidth: 2, dash: [6, 4]))
            let stop = Path(ellipseIn: CGRect(x: end - ring, y: y - ring, width: 2 * ring, height: 2 * ring))
            g.fill(stop, with: .color(.surface))
            g.stroke(stop, with: .color(.ink), lineWidth: 2.5)
            let w: CGFloat = 18
            let h: CGFloat = 12
            func bus(_ etaS: Int, live: Bool, alpha: Double) {
                let far = CGFloat(min(max(etaS, 0), roadS)) / CGFloat(roadS)
                let x = (end - ring - w - 2) * (1 - far)
                let r = Path(roundedRect: CGRect(x: x, y: y - h / 2, width: w, height: h), cornerRadius: 4)
                if live {
                    g.fill(r, with: .color(color.opacity(alpha)))
                } else {
                    g.stroke(r, with: .color(color.opacity(alpha)), lineWidth: 2)
                }
            }
            for b in row.later.reversed() { bus(b.etaS, live: b.quality == "live", alpha: 0.35) }
            if let s = row.etaS { bus(s, live: row.quality == "live", alpha: 1) }
        }
    }
}
