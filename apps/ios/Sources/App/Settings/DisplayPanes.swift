import SwiftUI
import WidgetKit

/// Settings › Notifications: the leave alert before class and the Live
/// Activity during a trip, on this phone only (kept in the app group as
/// TripPrefs, which the system part acts on). Turning the alert on asks for
/// permission; refused, the page says so, with the way to Settings.
struct SettingsNotificationsPane: View {
    @State private var leave = TripPrefs.leaveAlerts
    @State private var live = TripPrefs.liveActivity
    @State private var refused = false
    @Environment(\.scenePhase) private var phase

    var body: some View {
        if refused {
            Banner(text: L("Notifications are off for terminus."), tint: .warn) {
                Button(L("Open settings")) { Push.openSettings() }
                    .font(.subheadline.weight(.semibold))
                    .accessibilityIdentifier("settings.openSettings")
            }
        }
        SettingsGroup(title: L("Before class"), hint: L("Then updates on your ride or the next way there.")) {
            SettingSwitch(
                label: L("Notify me when to leave for class"), sub: L("A reminder 5 minutes before you need to leave"),
                isOn: Binding(get: { leave }, set: setLeave), id: "settings.leaveAlerts")
        }
        SettingsGroup(
            title: L("During a trip"), hint: L("Your bus and a countdown on the Lock Screen and in the Dynamic Island, until you arrive.")
        ) {
            SettingSwitch(
                label: L("Live Activity during trips"), sub: L("The next bus and a countdown, until you arrive"),
                isOn: Binding(get: { live }, set: setLive), id: "settings.liveActivity")
        }
        .onAppear(perform: check)
        .onChange(of: phase) { _, p in if p == .active { check() } }
    }

    private func setLeave(_ on: Bool) {
        guard on else {
            leave = false
            TripPrefs.leaveAlerts = false
            TripSync.prefsChanged()
            return
        }
        Task {
            let ok = await Push.askPermission()
            refused = !ok
            leave = ok
            TripPrefs.leaveAlerts = ok
            TripSync.prefsChanged()
        }
    }

    private func setLive(_ on: Bool) {
        live = on
        TripPrefs.liveActivity = on
        TripSync.prefsChanged()
    }

    /// Turned on here, but off in the phone's Settings since: said, with the way there.
    private func check() {
        leave = TripPrefs.leaveAlerts
        live = TripPrefs.liveActivity
        refused = leave && Push.notificationsDenied
    }
}

/// Settings › Language and time: the language (this phone and the account)
/// and 12- or 24-hour times (the account, so every device).
struct SettingsLanguagePane: View {
    let model: SettingsModel
    @Environment(Prefs.self) private var prefs

    var body: some View {
        SettingsGroup(
            title: L("Language"),
            hint: L("Also used on your Mac, on the web and in emails. Place and bus names stay in English, as on the signs.")
        ) {
            SettingSegments(
                label: L("Language"), options: [("auto", L("Auto")), ("en", "English"), ("zh", "中文")],
                selection: Binding(get: { prefs.lang }, set: model.setLang), id: "settings.lang")
        }
        SettingsGroup(
            title: L("Time format"), hint: L("For every time terminus shows, here, on your Mac and on the web. Auto follows this phone.")
        ) {
            SettingSegments(
                label: L("Time format"), options: [("auto", L("Auto")), ("12", L("12-hour")), ("24", L("24-hour"))],
                selection: Binding(get: { prefs.clock }, set: model.setClock), id: "settings.clock")
        }
    }
}

/// Settings › Appearance: the theme, and how the card draws a trip, both on this phone only.
struct SettingsAppearancePane: View {
    @Environment(Prefs.self) private var prefs

    var body: some View {
        SettingsGroup(title: L("Theme"), hint: L("Only on this phone.")) {
            SettingSegments(
                label: L("Theme"), options: [("auto", L("Auto")), ("light", L("Light")), ("dark", L("Dark"))],
                selection: Binding(get: { prefs.theme }, set: { prefs.theme = $0 }), id: "settings.theme")
        }
        SettingsCardStyles()
    }
}
