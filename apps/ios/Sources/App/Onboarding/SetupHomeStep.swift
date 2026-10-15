import SwiftUI

/// Where do you live? A residence brings all its stops; off campus, pick one.
struct SetupHomeStep: View {
    let model: OnboardingModel

    var body: some View {
        // Continue means a home is set; with none yet it's a skip, said as one.
        SetupPage(
            title: L("Where do you live?"),
            sub: L("Where you catch the bus in the morning and head back to at night. Only the stops are saved."), message: model.message
        ) {
            SetupButtons(skip: model.homeStops.isEmpty ? L("I'll do this later") : nil, next: model.next)
        } content: {
            if let campus = model.campus {
                SetupHomePicker(model: model, campus: campus)
            } else if model.message != nil {
                Button(L("Try again")) { Task { await model.loadCampus() } }
                    .buttonStyle(ChipButtonStyle(filled: true))
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(.vertical, 40)
            }
        }
    }
}

/// Residences as tiles: where most students live on their own at the top, then
/// a few of the others (the chosen one always among those showing) and off
/// campus. Your stops follow as their signs, with the buses that call there, so
/// the choice shows what it does.
private struct SetupHomePicker: View {
    let model: OnboardingModel
    let campus: Campus
    @State private var offCampus: Bool?
    @State private var all = false
    private var locator = Locator.shared

    /// How many of the other residences show before "All 15 halls and colleges".
    private static let few = 4

    private enum Cell: Hashable {
        case residence(Campus.Residence)
        case more, off
    }

    var body: some View {
        let stops = model.homeStops
        let residence = model.residence
        // Off campus once chosen, or when the stops are no residence's.
        let off = offCampus ?? (!stops.isEmpty && residence == nil)
        let common = campus.residences.filter { $0.common == true }
        let (shown, collapsed) = others(chosen: residence)

        VStack(alignment: .leading, spacing: 0) {
            if !common.isEmpty {
                SectionLabel(L("Most common")).padding(.bottom, 8)
                SetupTwoColumns(items: common.map(Cell.residence)) { cell($0, residence: residence, off: off) }
                SectionLabel(L("Elsewhere")).padding(.top, 18).padding(.bottom, 8)
            }
            SetupTwoColumns(items: shown.map(Cell.residence) + (collapsed ? [.more] : []) + [.off]) {
                cell($0, residence: residence, off: off)
            }

            if off {
                homeStop(stops)
                    .padding(.top, 16)
            }
            if !stops.isEmpty {
                SectionLabel(L("Your stops")).padding(.top, 22).padding(.bottom, 8)
                SetupTwoColumns(items: stops, gap: 10) { code in
                    let s = campus.stop(code)
                    SetupStopSign(name: s?.name ?? code, services: s?.services ?? [], campus: campus)
                }
                walk.padding(.top, 18)
            }
        }
    }

    /// The other residences showing, and whether some are folded away behind "All".
    private func others(chosen: Campus.Residence?) -> ([Campus.Residence], Bool) {
        let others = campus.residences.filter { $0.common != true }
        guard others.count > Self.few + 1 && !all else { return (others, false) }
        var shown = Array(others.prefix(Self.few))
        if let r = chosen, r.common != true, !shown.contains(r) { shown = shown.dropLast() + [r] }
        return (shown, true)
    }

    @ViewBuilder private func cell(_ c: Cell, residence: Campus.Residence?, off: Bool) -> some View {
        switch c {
        case .residence(let r):
            SetupChoiceTile(selected: residence == r && !off, id: "home.\(r.code)") {
                offCampus = false
                model.setResidence(r)
            } content: {
                Text(r.name)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ink)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                Text([r.stops.first.map(campus.stopName), L("%@ min walk", "\(r.minutes)")].compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .more:
            SetupChoiceTile(selected: false, id: "home.more") {
                withAnimation { all = true }
            } content: {
                Text(L("All %@ halls and colleges", "\(campus.residences.count)"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.brand)
                    .fixedSize(horizontal: false, vertical: true)
            }
        case .off:
            SetupChoiceTile(selected: off, id: "home.off") {
                offCampus = true
            } content: {
                Text(L("Off campus, or I'll pick a stop"))
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Off campus: the stop you start from, from a menu, or the one nearest the phone.
    @ViewBuilder private func homeStop(_ stops: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Menu {
                Picker(L("Home stop"), selection: Binding(get: { stops.first ?? "" }, set: { model.setFirstHomeStop($0) })) {
                    ForEach(campus.stops, id: \.code) { Text($0.name).tag($0.code) }
                }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("Home stop")).font(.caption.weight(.medium)).foregroundStyle(Color.muted)
                        Text(stops.first.map(campus.stopName) ?? L("Choose a stop"))
                            .font(.body)
                            .foregroundStyle(stops.isEmpty ? Color.faint : Color.ink)
                    }
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.footnote.weight(.semibold)).foregroundStyle(Color.muted)
                }
                .cardStyle(padding: 12, radius: 12)
                .contentShape(Rectangle())
            }
            .accessibilityIdentifier("home.stop")
            if locator.allowed {
                Button(L("Pick the stop nearest me")) { Task { await model.pickNearest() } }
                    .font(.subheadline.weight(.semibold))
                    .frame(minHeight: 44)
            }
            if let l = model.locating { SetupHint(l).announced(l) }
        }
    }

    private var walk: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 12) {
                Text(L("Walk from home to your stop"))
                    .font(.body)
                    .foregroundStyle(Color.ink)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(L("%@ min", "\(model.homeWalkMin)"))
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(Color.ink)
                    .accessibilityHidden(true)
                Stepper(
                    L("Walk from home to your stop"), value: Binding(get: { model.homeWalkMin }, set: { model.setHomeWalk($0) }),
                    in: model.walkRange
                )
                .labelsHidden()
                .accessibilityValue(L("%@ min", "\(model.homeWalkMin)"))
                .accessibilityIdentifier("home.walk")
            }
            SetupHint(L("Included in your departure time when your location isn't available."))
        }
    }
}

/// A stop's sign: its name on the plate, the bus mark in the accent, and the services that call there.
struct SetupStopSign: View {
    let name: String
    let services: [String]
    let campus: Campus

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 14, style: .continuous)
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 8) {
                Image(systemName: "bus.fill").font(.footnote).foregroundStyle(Color.brand)
                Text(name)
                    .font(.subheadline.weight(.bold))
                    .foregroundStyle(Color.ink)
                    .lineLimit(1)
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, minHeight: 38, alignment: .leading)
            .background(Color.surface2)
            .overlay(alignment: .bottom) { Rectangle().fill(Color.line).frame(height: 1) }
            SetupFlowRow(spacing: 5) {
                ForEach(services, id: \.self) { BusBadge(svc: $0, color: campus.color($0), size: 12) }
            }
            .padding(.horizontal, 11)
            .padding(.vertical, 10)
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Color.surface, in: shape)
        .clipShape(shape)
        .overlay(shape.strokeBorder(Color.line))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L("%@: %@", name, services.joined(separator: ", ")))
    }
}

/// Views left to right, wrapping onto the next line when there's no room.
struct SetupFlowRow: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0
        var y: CGFloat = 0
        var line: CGFloat = 0
        var widest: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                y += line + spacing
                x = 0
                line = 0
            }
            x += size.width + spacing
            widest = max(widest, x - spacing)
            line = max(line, size.height)
        }
        return CGSize(width: proposal.width ?? widest, height: y + line)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX
        var y = bounds.minY
        var line: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > bounds.minX && x + size.width > bounds.maxX {
                y += line + spacing
                x = bounds.minX
                line = 0
            }
            s.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
            x += size.width + spacing
            line = max(line, size.height)
        }
    }
}
