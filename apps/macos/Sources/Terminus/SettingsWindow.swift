import AppKit
import SwiftUI

// MARK: - Settings window

/// Settings' groups, in the order the sidebar shows them: the same as the
/// phone's and the website's.
enum SettingsPane: String, CaseIterable, Identifiable {
    case trips, timetable, favourites, notifications, devices, language, appearance, account

    var id: String { rawValue }

    var title: String {
        switch self {
        case .trips: L("Your trips")
        case .timetable: L("Timetable")
        case .favourites: L("Favourites")
        case .notifications: L("Notifications")
        case .devices: L("Devices")
        case .language: L("Language")
        case .appearance: L("Appearance")
        case .account: L("Account")
        }
    }

    var icon: String {
        switch self {
        case .trips: "figure.walk"
        case .timetable: "calendar"
        case .favourites: "star"
        case .notifications: "bell"
        case .devices: "laptopcomputer.and.iphone"
        case .language: "globe"
        case .appearance: "circle.lefthalf.filled"
        case .account: "person.crop.circle"
        }
    }
}

/// A sidebar of groups and the chosen one beside it, like the Mac's own
/// settings. The back arrow returns to the group shown before.
struct SettingsWindow: View {
    @Bindable var app: AppModel
    @State private var setup: SetupModel
    @State private var pane: SettingsPane?
    @State private var visited: [SettingsPane] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(app: AppModel, setup: SetupModel = SetupModel(), pane: SettingsPane = .trips) {
        self.app = app
        _setup = State(initialValue: setup)
        _pane = State(initialValue: pane)
    }

    var body: some View {
        NavigationSplitView {
            List(SettingsPane.allCases, selection: $pane) { p in
                Label(p.title, systemImage: p.icon).tag(p)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190, max: 240)
        } detail: {
            ScrollView {
                SettingsPaneView(pane: pane ?? .trips, app: app, setup: setup)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(24)
                    .id(pane)
                    .transition(.opacity)
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: pane)
            .navigationTitle((pane ?? .trips).title)
            .toolbar {
                ToolbarItem(placement: .navigation) {
                    Button { back() } label: { Image(systemName: "chevron.left") }
                        .disabled(visited.isEmpty)
                        .help(L("Back"))
                        .accessibilityLabel(L("Back"))
                }
            }
        }
        .frame(minWidth: 640, idealWidth: 700, minHeight: 460, idealHeight: 540)
        .onChange(of: pane) { old, _ in
            if let old, !going { visited.append(old) }
            going = false
        }
        .task {
            setup.onSaved = { Task { _ = await app.refresh() } }
            await setup.load()
            await setup.loadDevices()
        }
    }

    /// Set while the back arrow changes the pane, so that isn't recorded as a visit.
    @State private var going = false

    private func back() {
        guard let last = visited.popLast() else { return }
        going = true
        pane = last
    }
}

/// One group's settings.
struct SettingsPaneView: View {
    let pane: SettingsPane
    @Bindable var app: AppModel
    let setup: SetupModel
    @AppStorage(Appearance.key) private var theme = "auto"

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Devices shows its own, beside the list.
            if let message = setup.message, pane != .devices {
                Text(message).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            switch pane {
            case .trips:
                HomeStep(setup: setup, app: app)
                Divider().padding(.vertical, 8)
                PaceStep(setup: setup)
            case .timetable:
                TimetableStep(setup: setup)
            case .favourites:
                favourites
            case .notifications:
                Toggle(isOn: Binding(get: { app.leaveAlerts }, set: { app.setLeaveAlerts($0) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(L("Notify me when to leave for class"))
                        Hint(L("A heads-up 5 minutes before you need to leave, so you don't have to keep checking."))
                    }
                }
            case .devices:
                DevicesView(setup: setup)
            case .language:
                Picker(L("Language"), selection: Binding(get: { Lang.pref }, set: { app.setLang($0) })) {
                    Text(L("Follow this Mac")).tag("auto")
                    Text(verbatim: "English").tag("en")
                    Text(verbatim: "中文").tag("zh")
                }
                .pickerStyle(.radioGroup)
                Hint(L("Also used for emails and on your other devices. Place and bus names stay in English, as on the signs."))
            case .appearance:
                Picker(L("Theme"), selection: $theme) {
                    Text(L("Follow this Mac")).tag("auto")
                    Text(L("Light")).tag("light")
                    Text(L("Dark")).tag("dark")
                }
                .pickerStyle(.radioGroup)
                .onChange(of: theme) { Appearance.apply() }
                Hint(L("Only on this Mac."))
            case .account:
                account
            }
        }
    }

    @ViewBuilder private var favourites: some View {
        Hint(L("Available in one tap from the menu bar, the phone app and its widget."))
        if setup.places.isEmpty {
            Text(L("None yet")).foregroundStyle(.secondary)
        }
        ForEach(setup.places, id: \.key) { p in
            HStack {
                Label(p.label, systemImage: "star.fill").labelStyle(.titleAndIcon)
                Spacer()
                Button(L("Remove")) { setup.removePlace(p.key) }
                    .buttonStyle(.link)
                    .accessibilityLabel(L("Remove %@", p.label))
            }
        }
        if setup.places.count < SetupModel.maxPlaces {
            FavouriteSearch(app: app, setup: setup)
        }
        Hint(L("The times you usually go somewhere are set on the account page or in the phone app."))
        Button(L("Open the account page")) { NSWorkspace.shared.open(URL(string: "\(Api.site)/account/#favourites")!) }
            .buttonStyle(.link)
    }

    @ViewBuilder private var account: some View {
        Toggle(app.misplaced ? L("Open at login (move to Applications first)") : L("Open at login"), isOn: Binding(get: { app.openAtLogin }, set: { app.setOpenAtLogin($0) }))
            .disabled(app.misplaced && !app.openAtLogin)
        Button(Updater.shared.running ? L("Check for updates…") : L("Check for updates (move to Applications first)")) {
            Updater.shared.checkNow()
        }
        .disabled(!Updater.shared.running)
        Divider().padding(.vertical, 8)
        Hint(L("Your email, API keys, signing out everywhere and deleting your account are on the account page."))
        HStack {
            Button(L("Open the account page")) { NSWorkspace.shared.open(URL(string: "\(Api.site)/account/#account")!) }
            Button(L("Sign out of this Mac")) { app.unpair() }
        }
    }
}

/// Adding a favourite: the same search as the popover's, a pick adds it.
private struct FavouriteSearch: View {
    @Bindable var app: AppModel
    let setup: SetupModel
    @State private var query = ""
    @State private var note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            TextField(L("Add a stop, building or room"), text: $query)
                .textFieldStyle(.roundedBorder)
                .onChange(of: query) { _, _ in app.loadDestinations() }
            let q = query.trimmingCharacters(in: .whitespaces)
            if !q.isEmpty {
                ForEach(Array(rankDestinations(app.destinations, q)), id: \.self) { d in
                    Button {
                        query = ""
                        note = setup.addPlace(d).map { L("Already a favourite: %@", $0) }
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(d.label)
                            if d.label != d.code { Text(d.code).font(.caption).foregroundStyle(.secondary) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 3)
                }
            }
            if let note { Hint(note) }
        }
        .padding(.top, 4)
    }
}
