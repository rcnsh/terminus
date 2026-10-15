import CoreLocation
import SwiftUI

/// Settings › Your trips: where you live, your day's hours and how you walk,
/// each a short group with one line under it; then the classes you chose a
/// bus earlier or no reminders for, and the trip history. As on Android
/// (TripsSettings.kt), the web and the Mac.
struct SettingsTripsPane: View {
    let model: SettingsModel

    var body: some View {
        if let p = model.profile {
            if let campus = model.campus { HomeGroup(model: model, profile: p, campus: campus) }
            DayGroup(model: model, profile: p)
            WalkingGroup(model: model, profile: p)
            TripChoicesGroup(model: model)
            TripHistoryGroup(model: model)
        } else {
            SettingsProfileLoading()
        }
    }
}

private struct HomeGroup: View {
    let model: SettingsModel
    let profile: ProfileDoc
    let campus: Campus
    /// "Off campus" chosen while the stops are still a residence's: it stays until the stops change.
    @State private var offCampus = false
    @State private var locating: String?

    var body: some View {
        let stops = profile.homeStops
        // The residence whose stops these are, if they're exactly one's; the common ones come first.
        let residence = campus.residences.first { $0.stops == stops }
        let picking = offCampus || residence == nil
        SettingsGroup(title: L("Where you live"), hint: L("Only your stops are saved.")) {
            SettingRow(
                label: L("Residence"),
                sub: picking
                    ? nil : residence.map { r in L("Your stops: %@.", r.stops.map(campus.stopName).joined(separator: settingsListSep)) }
            ) {
                residenceMenu(residence: picking ? nil : residence)
            }
            if picking {
                GroupDivider()
                SettingRow(label: L("Your stop")) { stopMenu(stops) }
                if Locator.shared.allowed {
                    VStack(alignment: .leading, spacing: 4) {
                        Button(L("Pick the stop nearest me")) { Task { await pickNearest(stops) } }
                            .font(.subheadline.weight(.medium))
                            .accessibilityIdentifier("settings.nearest")
                        if let locating { SettingsHint(locating) }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 12)
                }
            }
            GroupDivider()
            SettingRow(label: L("Walk to your stop")) {
                SettingsStepper(
                    text: L("%@ min", "\(profile.homeWalkMin)"),
                    less: L("One minute less"), more: L("One minute more"),
                    canLess: profile.homeWalkMin > profile.limits.homeWalkMin.lowerBound,
                    canMore: profile.homeWalkMin < profile.limits.homeWalkMin.upperBound,
                    onLess: { model.edit { $0.homeWalkMin -= 1 } },
                    onMore: { model.edit { $0.homeWalkMin += 1 } }
                )
            }
        }
        .onChange(of: stops) { _, _ in offCampus = false }
    }

    private func residenceMenu(residence: Campus.Residence?) -> some View {
        let common = campus.residences.filter { $0.common == true }
        let other = campus.residences.filter { $0.common != true }
        return Menu {
            if !common.isEmpty {
                Section(L("Most common")) { ForEach(common, id: \.code) { r in residenceButton(r) } }
            }
            Section(common.isEmpty ? "" : L("Other residences")) { ForEach(other, id: \.code) { r in residenceButton(r) } }
            Section { Button(L("Off campus")) { offCampus = true } }
        } label: {
            SettingsMenuValue(text: residence?.name ?? L("Off campus"))
        }
        .accessibilityLabel(L("Residence"))
        .accessibilityValue(residence?.name ?? L("Off campus"))
        .accessibilityIdentifier("settings.residence")
    }

    private func residenceButton(_ r: Campus.Residence) -> some View {
        Button(r.name) {
            offCampus = false
            model.edit {
                $0.setHomeStops(r.stops)
                $0.homeWalkMin = r.minutes
            }
        }
    }

    private func stopMenu(_ stops: [String]) -> some View {
        Menu {
            ForEach(campus.stops, id: \.code) { s in
                Button(s.name) { model.edit { $0.setHomeStops([s.code] + stops.dropFirst().filter { $0 != s.code }) } }
            }
        } label: {
            SettingsMenuValue(text: stops.first.map(campus.stopName) ?? L("Choose a stop"))
        }
        .accessibilityLabel(L("Your stop"))
        .accessibilityIdentifier("settings.homeStop")
    }

    /// "Pick the stop nearest me": that stop first among your home stops, the rest kept after it.
    private func pickNearest(_ stops: [String]) async {
        locating = L("Finding the nearest stop…")
        guard let loc = await Locator.shared.fix(maxAge: 120), let near = settingsNearestStop(campus.stops, to: loc.coordinate) else {
            locating = L("Couldn't get your location. Choose your stop instead.")
            return
        }
        model.edit { $0.setHomeStops([near.code] + stops.filter { $0 != near.code }) }
        locating = L("Picked %@. Change it if you use a different stop.", near.name)
    }
}

/// The stop nearest a point, as the crow flies.
func settingsNearestStop(_ stops: [Campus.Stop], to c: CLLocationCoordinate2D) -> Campus.Stop? {
    let here = CLLocation(latitude: c.latitude, longitude: c.longitude)
    return
        stops
        .compactMap { s -> (Campus.Stop, CLLocationDistance)? in
            guard let lat = s.lat, let lon = s.lon else { return nil }
            return (s, here.distance(from: CLLocation(latitude: lat, longitude: lon)))
        }
        .min { $0.1 < $1.1 }?.0
}

/// What a menu row has chosen, and the up-down chevrons that say it opens a menu.
struct SettingsMenuValue: View {
    let text: String
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        HStack(spacing: 4) {
            Text(text).multilineTextAlignment(type.isAccessibilitySize ? .leading : .trailing).lineLimit(3)
            Image(systemName: "chevron.up.chevron.down").font(.caption.weight(.semibold))
        }
        .foregroundStyle(Color.brand)
        .frame(maxWidth: type.isAccessibilitySize ? .infinity : 210, alignment: type.isAccessibilitySize ? .leading : .trailing)
    }
}

/// − value +, for small steps: round buttons either side, as on Android and the web.
struct SettingsStepper: View {
    let text: String
    let less: String
    let more: String
    let canLess: Bool
    let canMore: Bool
    let onLess: () -> Void
    let onMore: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            step("minus", less, canLess, onLess)
            Text(text).monospacedDigit().lineLimit(1).fixedSize().frame(minWidth: 64).multilineTextAlignment(.center).accessibilityHidden(
                true)
            step("plus", more, canMore, onMore)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityValue(text)
        .accessibilityAdjustableAction { d in
            switch d {
            case .increment: if canMore { onMore() }
            case .decrement: if canLess { onLess() }
            @unknown default: break
            }
        }
    }

    private func step(_ icon: String, _ says: String, _ enabled: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.subheadline.weight(.bold))
                .frame(width: 34, height: 34)
                .background(Color.surface2, in: Circle())
                .foregroundStyle(enabled ? Color.ink : Color.faint)
        }
        .buttonStyle(.borderless)
        .disabled(!enabled)
        .accessibilityLabel(says)
        .accessibilityIdentifier(says)
    }
}

private struct DayGroup: View {
    let model: SettingsModel
    let profile: ProfileDoc

    var body: some View {
        SettingsGroup(title: L("Your day"), hint: L("Outside these hours, you see your next class instead of a bus.")) {
            VStack(alignment: .leading, spacing: 8) {
                Text(L("Show buses between")).foregroundStyle(Color.ink)
                HStack(spacing: 8) {
                    SettingsTimeField(label: L("Show buses from"), minutes: profile.dayStartMin) { m in
                        if m < profile.dayEndMin { model.edit { $0.dayStartMin = m } }
                    }
                    Text(L("and")).foregroundStyle(Color.muted)
                    SettingsTimeField(label: L("Show buses until"), minutes: profile.dayEndMin) { m in
                        if m > profile.dayStartMin { model.edit { $0.dayEndMin = m } }
                    }
                    Spacer(minLength: 0)
                }
            }
            .padding(16)
            GroupDivider()
            SettingRow(label: L("Go home in gaps longer than")) {
                let h = profile.gapHours
                SettingsStepper(
                    text: h == 1 ? L("1 hour") : L("%@ hours", h.truncatingRemainder(dividingBy: 1) == 0 ? "\(Int(h))" : "\(h)"),
                    less: L("Half an hour shorter"), more: L("Half an hour longer"),
                    canLess: h > 0.5, canMore: h < 12,
                    onLess: { model.edit { $0.gapHours -= 0.5 } },
                    onMore: { model.edit { $0.gapHours += 0.5 } }
                )
            }
        }
    }
}

/// A time of day as the system's compact time picker, in the account's clock and the campus's minutes.
struct SettingsTimeField: View {
    let label: String
    let minutes: Int
    let onPick: (Int) -> Void

    var body: some View {
        DatePicker(
            label, selection: Binding(get: { SettingsTime.date(minutes) }, set: { onPick(SettingsTime.minutes($0)) }),
            displayedComponents: .hourAndMinute
        )
        .labelsHidden()
        .environment(\.timeZone, TimeZone(identifier: "UTC")!)
        .environment(\.locale, SettingsTime.pickerLocale)
        .accessibilityLabel(label)
        .accessibilityIdentifier(label)
    }
}

private struct WalkingGroup: View {
    let model: SettingsModel
    let profile: ProfileDoc

    private static var paces: [(String, String)] {
        [
            ("slow", L("400 m in about 6 min. A relaxed pace, or if you often carry a bag.")),
            ("normal", L("400 m in about 5 min. An average pace.")),
            ("fast", L("400 m in about 4 min. A brisk pace.")),
        ]
    }

    var body: some View {
        let pace = Self.paces.first { $0.0 == profile.walkPace } ?? Self.paces[1]
        SettingsGroup(title: L("Walking"), hint: L("Walks follow the paths on campus.")) {
            VStack(alignment: .leading, spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Walking pace")).foregroundStyle(Color.ink)
                    SettingsHint(pace.1)
                }
                Picker(L("Walking pace"), selection: Binding(get: { pace.0 }, set: { v in model.edit { $0.walkPace = v } })) {
                    ForEach(Self.paces, id: \.0) { Text(settingsPaceName($0.0)).tag($0.0) }
                }
                .pickerStyle(.segmented)
                .accessibilityIdentifier("settings.pace")
            }
            .padding(16)
            GroupDivider()
            SettingSwitch(
                label: L("Prefer the bus"), sub: L("Wait a few minutes more for a bus rather than walk."),
                isOn: Binding(get: { profile.preferBus }, set: { v in model.edit { $0.preferBus = v } }), id: "settings.preferBus")
            GroupDivider()
            SettingSwitch(
                label: L("Allow for busy buses"), sub: L("Aim one bus earlier when yours is often full."),
                isOn: Binding(get: { profile.fullBusMargin }, set: { v in model.edit { $0.fullBusMargin = v } }), id: "settings.busy")
            GroupDivider()
            SettingSwitch(
                label: L("Public buses"),
                sub: L(
                    "Count the 95, 151 and other public buses at your stops too. They have a fare, so one is the answer only when it clearly saves time."
                ),
                isOn: Binding(get: { profile.publicBuses }, set: { v in model.edit { $0.publicBuses = v } }), id: "settings.public")
        }
    }
}

/// What you chose for particular classes, each undoable.
private struct TripChoicesGroup: View {
    let model: SettingsModel

    var body: some View {
        if !model.choices.isEmpty {
            SettingsGroup(title: L("Your classes")) {
                ForEach(Array(model.choices.enumerated()), id: \.element) { i, c in
                    if i > 0 { GroupDivider() }
                    let name = c.label ?? L("A class no longer in your timetable")
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(name).foregroundStyle(Color.ink)
                            SettingsHint(c.pref == "earlier" ? L("One bus earlier") : L("No reminders"))
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        QuietRemove(title: L("Undo"), says: L("Undo for %@", name)) { model.undoChoice(c) }
                    }
                    .padding(.leading, 16)
                    .padding(.trailing, 8)
                    .padding(.vertical, 6)
                }
            }
        }
    }
}

/// How each trip went, kept 35 days for the suggestions; cleared here without touching the rest.
private struct TripHistoryGroup: View {
    let model: SettingsModel
    @State private var confirm = false

    var body: some View {
        if model.history > 0 {
            SettingsGroup(title: L("Trip history"), hint: L("Kept for 35 days and used only to spot classes you often miss or skip.")) {
                HStack {
                    Text(model.history == 1 ? L("1 trip recorded") : L("%@ trips recorded", "\(model.history)"))
                        .foregroundStyle(Color.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button(L("Clear trip history")) { confirm = true }
                        .font(.subheadline.weight(.medium))
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("settings.clearHistory")
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 52)
            }
            .alert(L("Clear trip history?"), isPresented: $confirm) {
                Button(L("Clear"), role: .destructive) { model.clearHistory() }
                Button(L("Cancel"), role: .cancel) {}
            } message: {
                Text(L("This clears your trip history. Your class settings won't change."))
            }
        }
    }
}
