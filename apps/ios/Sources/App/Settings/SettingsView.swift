import SwiftUI

struct SettingsView: View {
    @State private var model = SettingsModel.shared
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var phase
    @Environment(\.windowWidth) private var width
    @State private var signingIn = false

    var body: some View {
        Group {
            if width.panes {
                ListDetail {
                    NavigationStack { SettingsList(model: model).listPaneRoot().keyboardRoom() }
                } detail: {
                    NavigationStack(path: model.pagesOver) {
                        SettingsPageView(page: model.shown, model: model)
                            .environment(\.paneRoot, true)
                            .id(model.shown)
                            .keyboardRoom()
                            .navigationDestination(for: SettingsPage.self) { page in
                                SettingsPageView(page: page, model: model).keyboardRoom()
                            }
                    }
                }
            } else {
                NavigationStack(path: $model.path) {
                    SettingsList(model: model)
                        .keyboardRoom()
                        .navigationDestination(for: SettingsPage.self) { page in
                            SettingsPageView(page: page, model: model).keyboardRoom()
                        }
                }
            }
        }
        .onChange(of: width.panes, initial: true) { _, panes in model.split = panes }
        .overlay(alignment: .bottom) {
            SettingsToast(model: model).animation(.snappy, value: model.message)
        }
        .task { await model.refresh() }
        .onChange(of: phase) { _, p in if p == .active { Task { await model.refresh() } } }
        .onChange(of: app.session) { _, _ in model.reset() }
        .onReceive(NotificationCenter.default.publisher(for: .settingsSignIn)) { _ in signingIn = true }
        .sheet(isPresented: $signingIn, onDismiss: { Task { await model.refresh() } }) { SignInSheet().centredSheet() }
        .onReceive(NotificationCenter.default.publisher(for: .settingsImportTimetable)) { n in
            guard let link = n.object as? String else { return }
            model.sharedLink = link
            model.path = [.timetable]
        }
    }
}

extension Notification.Name {
    static let settingsImportTimetable = Notification.Name("terminus.importTimetable")
    static let settingsSignIn = Notification.Name("terminus.signIn")
}

private struct SettingsList: View {
    let model: SettingsModel
    @Environment(AppModel.self) private var app
    @Environment(Prefs.self) private var prefs
    @Environment(\.dynamicTypeSize) private var type
    @Environment(\.listPane) private var listPane

    var body: some View {
        SettingsScaffold(title: L("Settings"), back: false) {
            VStack(spacing: 12) {
                accountTile
                ForEach(Array(Self.groups.enumerated()), id: \.offset) { _, group in
                    SettingsGroup(title: nil) {
                        ForEach(Array(group.enumerated()), id: \.element.0) { i, row in
                            if i > 0 { GroupDivider(inset: 0) }
                            self.row(row.0, icon: row.1)
                        }
                    }
                }
                Button(L("About")) { model.open(.about) }
                    .font(.body.weight(.medium))
                    .foregroundStyle(Color.brand)
                    .frame(maxWidth: .infinity, minHeight: 44)
                    .chosenRow(model.chosen == .about)
                    .accessibilityIdentifier("settings.about")
            }
        }
    }

    private static let groups: [[(SettingsPage, String)]] = [
        [(.trips, "mappin.and.ellipse"), (.timetable, "calendar"), (.favourites, "heart"), (.notifications, "bell")],
        [(.language, "globe"), (.appearance, "circle.lefthalf.filled"), (.devices, "ipad.and.iphone")],
        [(.feedback, "bubble.left")],
    ]

    private var accountTile: some View {
        Button {
            model.open(.account)
        } label: {
            HStack(spacing: 12) {
                if let email = app.email { AccountInitial(email: email) } else { SettingsMark() }
                VStack(alignment: .leading, spacing: 2) {
                    Text(app.email ?? L("Not signed in"))
                        .font(.headline)
                        .foregroundStyle(Color.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let s = devicesSummary {
                        Text(s).font(.subheadline).foregroundStyle(app.email == nil ? Color.brand : Color.muted).lineLimit(2)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint)
            }
            .padding(16)
            .chosenRow(model.chosen == .account)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(SettingsTilePressStyle())
        .accessibilityIdentifier("settings.account")
    }

    private func row(_ page: SettingsPage, icon: String) -> some View {
        let s = summary(page)
        let said = s.text.map { t in
            Text(t)
                .font(.subheadline.weight(s.tone == .plain ? .regular : .semibold))
                .foregroundStyle(s.tone == .todo ? Color.brand : s.tone == .off ? Color.warn : Color.muted)
        }
        return Button {
            model.open(page)
        } label: {
            HStack(spacing: 14) {
                Image(systemName: icon)
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(Color.brand)
                    .frame(width: 32, height: 32)
                    .background(Color.brandSoft, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
                    .accessibilityHidden(true)
                let under = VStack(alignment: .leading, spacing: 2) {
                    Text(page.title).foregroundStyle(Color.ink)
                    said
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if type.isAccessibilitySize || listPane {
                    under
                } else {
                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 14) {
                            Text(page.title).foregroundStyle(Color.ink).lineLimit(1).layoutPriority(1)
                            (said ?? Text(verbatim: ""))
                                .lineLimit(1)
                                .frame(maxWidth: .infinity, alignment: .trailing)
                        }
                        under
                    }
                }
                Image(systemName: "chevron.forward").font(.footnote.weight(.semibold)).foregroundStyle(Color.faint)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(minHeight: 56)
            .chosenRow(model.chosen == page)
            .contentShape(Rectangle())
        }
        .buttonStyle(SettingsTilePressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.tile.\(page)")
    }

    private enum Tone { case plain, todo, off }

    private func summary(_ page: SettingsPage) -> (text: String?, tone: Tone) {
        let p = model.profile
        switch page {
        case .trips:
            guard let p else { return (nil, .plain) }
            guard let home = p.homeStops.first else { return (L("Choose your stop"), .todo) }
            return ("\(model.campus?.stopName(home) ?? home) · \(L("%@ pace", settingsPaceName(p.walkPace)))", .plain)
        case .timetable:
            if model.me?.needsReimport == true { return (L("Re-import needed"), .todo) }
            guard let p else { return (nil, .plain) }
            let n = p.trips.count + p.manual.count
            return n == 0 ? (L("Import from NUSMods"), .todo) : (settingsClassCount(n), .plain)
        case .favourites:
            guard let p else { return (nil, .plain) }
            return (p.places.isEmpty ? L("None yet") : p.places.map(\.label).joined(separator: settingsListSep), .plain)
        case .notifications:
            let on = [TripPrefs.leaveAlerts ? L("Leave alerts") : nil, TripPrefs.liveActivity ? L("Live Activity") : nil].compactMap { $0 }
            return on.isEmpty ? (L("All off"), .off) : (on.joined(separator: settingsListSep), .plain)
        case .language:
            let lang =
                switch prefs.lang {
                case "en": "English"
                case "zh": "中文"
                default: settingsFollowDevice
                }
            let clock: String? =
                switch prefs.clock {
                case "12": L("12-hour")
                case "24": L("24-hour")
                default: nil
                }
            return ([lang, clock].compactMap { $0 }.joined(separator: " · "), .plain)
        case .appearance:
            let parts = [settingsThemeName(prefs.theme), settingsCardStyleName(prefs.cardStyle), prefs.newToNus ? L("New to NUS") : nil]
            return (parts.compactMap { $0 }.joined(separator: " · "), .plain)
        case .devices:
            if app.email == nil { return (L("Add an email to use other devices"), .plain) }
            return (model.devices.map { settingsDeviceCount($0.count) }, .plain)
        default:
            return (nil, .plain)
        }
    }

    private var devicesSummary: String? {
        if app.email == nil { return L("Add your email") }
        return model.devices.map { settingsDeviceCount($0.count) }
    }
}

struct SettingsTilePressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label.opacity(configuration.isPressed ? 0.7 : 1)
    }
}

func settingsPaceName(_ pace: String) -> String {
    switch pace {
    case "slow": L("Slow")
    case "fast": L("Fast")
    default: L("Normal")
    }
}

var settingsFollowDevice: String { onIPad ? L("Follow this iPad") : L("Follow this phone") }

@MainActor func settingsThemeName(_ theme: String) -> String {
    switch theme {
    case "light": L("Light")
    case "dark": L("Dark")
    default: settingsFollowDevice
    }
}

func settingsCardStyleName(_ style: String) -> String {
    switch style {
    case "route": L("Route")
    default: L("Steps")
    }
}

private struct SettingsPageView: View {
    let page: SettingsPage
    let model: SettingsModel

    var body: some View {
        SettingsScaffold(title: page.title) {
            switch page {
            case .trips: SettingsTripsPane(model: model)
            case .timetable: SettingsTimetablePane(model: model)
            case .favourites: SettingsFavouritesPane(model: model)
            case .notifications: SettingsNotificationsPane()
            case .language: SettingsLanguagePane(model: model)
            case .appearance: SettingsAppearancePane()
            case .devices: SettingsDevicesPane(model: model)
            case .account: SettingsAccountPane(model: model)
            case .feedback: SettingsFeedbackPane(model: model)
            case .about: SettingsAboutPane(model: model)
            case .licences: SettingsLicencesPane()
            }
        }
    }
}

struct SettingsProfileLoading: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            ForEach(0..<2, id: \.self) { g in
                VStack(alignment: .leading, spacing: 8) {
                    SkeletonLine(font: .caption.weight(.semibold), points: [90, 120][g]).padding(.horizontal, 4)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(0..<3, id: \.self) { i in
                            if i > 0 { GroupDivider() }
                            SettingsSkeletonRow(seed: g * 3 + i)
                        }
                    }
                    .background(Color.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
                    .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line))
                }
            }
        }
        .shimmering()
        .skeletonSpoken()
    }
}

struct SettingsSkeletonRow: View {
    var seed = 0

    var body: some View {
        HStack(spacing: 12) {
            SkeletonLine(font: .body, fraction: SkeletonWidths.name(seed) * 0.8)
            SkeletonBar(width: 64, height: 24, radius: 12)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(minHeight: 52)
    }
}
