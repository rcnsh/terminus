import SwiftUI

/// Settings: everything the account page has, so the website is optional for
/// daily use. Who you are, then the rest as tiles, each saying what's set,
/// each opening a page; About under them. As on Android (Settings.kt).
struct SettingsView: View {
    @State private var model = SettingsModel.shared
    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var phase
    @State private var signingIn = false

    var body: some View {
        NavigationStack(path: $model.path) {
            SettingsList(model: model)
                .navigationDestination(for: SettingsPage.self) { page in
                    SettingsPageView(page: page, model: model)
                }
        }
        .overlay(alignment: .bottom) {
            SettingsToast(model: model).animation(.snappy, value: model.message)
        }
        // On opening, and each time the app comes back while Settings shows:
        // a device added or a change made on another one shows here.
        .task { await model.refresh() }
        .onChange(of: phase) { _, p in if p == .active { Task { await model.refresh() } } }
        .onChange(of: app.session) { _, _ in model.reset() }
        // "Add your email", here or from Now's "Is this wrong?": the email sign-in, which keeps this phone's setup.
        .onReceive(NotificationCenter.default.publisher(for: .settingsSignIn)) { _ in signingIn = true }
        .sheet(isPresented: $signingIn, onDismiss: { Task { await model.refresh() } }) { SignInSheet() }
        // A NUSMods link shared into the app: straight to Timetable, to import it.
        .onReceive(NotificationCenter.default.publisher(for: .settingsImportTimetable)) { n in
            guard let link = n.object as? String else { return }
            model.sharedLink = link
            model.path = [.timetable]
        }
    }
}

extension Notification.Name {
    /// A NUSMods share link to import: `object` is the link. Opens Settings › Timetable with it filled in.
    static let settingsImportTimetable = Notification.Name("terminus.importTimetable")
    /// Asks for the email sign-in, to add an email to an anonymous account (the welcome flow's sheet).
    static let settingsSignIn = Notification.Name("terminus.signIn")
}

/// The list: who you are, the tiles, About.
private struct SettingsList: View {
    let model: SettingsModel
    @Environment(AppModel.self) private var app
    @Environment(Prefs.self) private var prefs
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        SettingsScaffold(title: L("Settings"), back: false) {
            accountTile
            let columns =
                type.isAccessibilitySize
                ? [GridItem(.flexible())] : [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]
            LazyVGrid(columns: columns, spacing: 10) {
                ForEach(Self.tiles, id: \.0) { page, icon in
                    tile(page, icon: icon)
                }
            }
            Button(L("About")) { model.path.append(.about) }
                .font(.body.weight(.medium))
                .foregroundStyle(Color.brand)
                .frame(maxWidth: .infinity, minHeight: 44)
                .accessibilityIdentifier("settings.about")
        }
    }

    private static let tiles: [(SettingsPage, String)] = [
        (.trips, "mappin.and.ellipse"),
        (.timetable, "calendar"),
        (.favourites, "heart"),
        (.notifications, "bell"),
        (.language, "globe"),
        (.appearance, "circle.lefthalf.filled"),
        (.devices, "laptopcomputer.and.iphone"),
        (.feedback, "bubble.left"),
    ]

    /// Who you are: your email (or that you're not signed in) and your devices, opening Account.
    private var accountTile: some View {
        Button {
            model.path.append(.account)
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
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(SettingsTilePressStyle())
        .accessibilityIdentifier("settings.account")
    }

    private func tile(_ page: SettingsPage, icon: String) -> some View {
        let s = summary(page)
        return Button {
            model.path.append(page)
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(Color.brand)
                    .frame(height: 26)
                    .accessibilityHidden(true)
                Spacer(minLength: 12)
                Text(page.title).font(.subheadline.weight(.bold)).foregroundStyle(Color.ink).multilineTextAlignment(.leading)
                if let said = s.text {
                    Text(said)
                        .font(.footnote.weight(s.tone == .plain ? .regular : .semibold))
                        .foregroundStyle(s.tone == .todo ? Color.brand : s.tone == .off ? Color.warn : Color.muted)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 104, alignment: .topLeading)
            .padding(14)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).strokeBorder(Color.line))
            .contentShape(RoundedRectangle(cornerRadius: 18))
        }
        .buttonStyle(SettingsTilePressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("settings.tile.\(page)")
    }

    private enum Tone { case plain, todo, off }

    /// What's set on a page, in a line. What isn't set yet (a home stop,
    /// classes) says what to do, in the accent; notifications all off, in amber.
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
                default: L("Follow this phone")
                }
            let clock: String? =
                switch prefs.clock {
                case "12": L("12-hour")
                case "24": L("24-hour")
                default: nil
                }
            return ([lang, clock].compactMap { $0 }.joined(separator: " · "), .plain)
        case .appearance:
            return ("\(settingsThemeName(prefs.theme)) · \(settingsCardStyleName(prefs.cardStyle))", .plain)
        case .devices:
            if app.email == nil { return (L("Add an email to use other devices"), .plain) }
            return (model.devices.map { settingsDeviceCount($0.count) }, .plain)
        case .feedback:
            return (L("Tell us what's wrong, or what you'd like"), .plain)
        default:
            return (nil, .plain)
        }
    }

    private var devicesSummary: String? {
        if app.email == nil { return L("Add your email") }
        return model.devices.map { settingsDeviceCount($0.count) }
    }
}

/// A tile's press: dimmed while held.
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

func settingsThemeName(_ theme: String) -> String {
    switch theme {
    case "light": L("Light")
    case "dark": L("Dark")
    default: L("Follow this phone")
    }
}

func settingsCardStyleName(_ style: String) -> String {
    switch style {
    case "ticket": L("Ticket")
    case "route": L("Route")
    default: L("Steps")
    }
}

/// One page of Settings.
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

/// While the profile is on its way: a spinner where the page will be.
struct SettingsProfileLoading: View {
    var body: some View {
        ProgressView().frame(maxWidth: .infinity).padding(40)
    }
}
