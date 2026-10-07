import AppKit
import SwiftUI

// MARK: - Settings window

/// Settings' groups, in the order the sidebar shows them: the same as the
/// phone's and the website's.
enum SettingsPane: String, CaseIterable, Identifiable {
    case trips, timetable, favourites, notifications, devices, language, appearance, account, about, feedback

    var id: String { rawValue }

    /// The sidebar's groups, under their headings, as on the phone and the web;
    /// About and Send feedback after them.
    static let groups: [(String?, [SettingsPane])] = [
        (L("Your day"), [.trips, .timetable, .favourites, .notifications]),
        (L("Account"), [.account, .devices]),
        (L("Display"), [.language, .appearance]),
        (nil, [.about, .feedback]),
    ]

    var title: String {
        switch self {
        case .trips: L("Your trips")
        case .timetable: L("Timetable")
        case .favourites: L("Favourites")
        case .notifications: L("Notifications")
        case .devices: L("Devices")
        case .language: L("Language and time")
        case .appearance: L("Appearance")
        case .account: L("Account")
        case .about: L("About")
        case .feedback: L("Send feedback")
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
        case .about: "info.circle"
        case .feedback: "bubble.left"
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
    /// Set while the back arrow changes the pane, so that isn't recorded as a visit.
    @State private var going = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(app: AppModel, setup: SetupModel = SetupModel(), pane: SettingsPane = .trips) {
        self.app = app
        _setup = State(initialValue: setup)
        _pane = State(initialValue: pane)
    }

    var body: some View {
        NavigationSplitView {
            List(selection: $pane) {
                ForEach(SettingsPane.groups, id: \.1) { title, panes in
                    Section {
                        ForEach(panes) { p in Label(p.title, systemImage: p.icon).tag(p) }
                    } header: {
                        if let title { Text(title) }
                    }
                }
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
        .onChange(of: app.settingsPane, initial: true) { _, asked in
            guard let asked else { return }
            pane = asked
            app.settingsPane = nil
        }
        .task {
            setup.onSaved = { Task { _ = await app.refresh() } }
            await setup.load()
            await setup.loadDevices()
        }
    }

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
    @State private var confirmDelete = false
    @State private var confirmSignOut = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Devices shows its own, beside the list.
            if let message = setup.message, pane != .devices {
                Text(message).foregroundStyle(Color.bad).fixedSize(horizontal: false, vertical: true).announced(message)
            }
            switch pane {
            case .trips:
                TripsPane(setup: setup, app: app)
                ChoicesSection(setup: setup).padding(.top, 10)
            case .timetable:
                TimetablePane(app: app, setup: setup)
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
                Picker(L("Time format"), selection: Binding(get: { setup.clock }, set: { setup.setClock($0) })) {
                    Text(L("Follow this Mac")).tag("auto")
                    Text(L("12-hour (%@)", L("6:36 PM"))).tag("12")
                    Text(L("24-hour (%@)", "18:36")).tag("24")
                }
                .pickerStyle(.radioGroup)
                .padding(.top, 12)
                Hint(L("For every time terminus shows, here, on your phone and on the web."))
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
            case .about:
                AboutPane()
            case .feedback:
                FeedbackPane(app: app, setup: setup)
            }
        }
        // The import's answer replaces the profile, so nothing that edits it
        // takes a click until it's in (SetupModel.edit refuses them meanwhile).
        .disabled(setup.importing)
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
        if setup.places.count < setup.maxPlaces {
            FavouriteSearch(app: app, setup: setup)
        }
        Hint(L("To go somewhere every week, add it to your timetable."))
    }

    @ViewBuilder private var account: some View {
        Toggle(app.misplaced ? L("Open at login (move to Applications first)") : L("Open at login"), isOn: Binding(get: { app.openAtLogin }, set: { app.setOpenAtLogin($0) }))
            .disabled(app.misplaced && !app.openAtLogin)
        Button(Updater.shared.running ? L("Check for updates…") : L("Check for updates (move to Applications first)")) {
            Updater.shared.checkNow()
        }
        .disabled(!Updater.shared.running)
        Divider().padding(.vertical, 8)
        if app.anonymous || setup.me?.anonymous == true {
            Text(L("No email")).fontWeight(.medium)
            AddEmail(app: app)
            HStack {
                Button(L("Download my data")) { Task { await setup.export() } }
                Button(L("Delete account"), role: .destructive) { confirmDelete = true }
            }
            .padding(.top, 8)
            .confirmationDialog(L("Delete this account?"), isPresented: $confirmDelete) {
                Button(L("Delete"), role: .destructive) { app.deleteAnonymousAccount() }
            } message: {
                Text(L("Your timetable and settings will be deleted immediately and this Mac will reset. Without an email on the account, they can't be recovered."))
            }
        } else {
            if let email = setup.me?.email { Text(L("Signed in as %@", email)).fontWeight(.medium) }
            HStack {
                Button(L("Download my data")) { Task { await setup.export() } }
                Button(L("Sign out of this Mac")) { confirmSignOut = true }
            }
            .confirmationDialog(L("Sign out of this Mac?"), isPresented: $confirmSignOut) {
                Button(L("Sign out"), role: .destructive) { app.unpair() }
            }
            Divider().padding(.vertical, 8)
            // As on Android: the rest of the account is on the web, deleting it too
            // (where you sign in again to confirm), but each has its own way there.
            VStack(alignment: .leading, spacing: 2) {
                Button(L("Open the account page")) { openAccountPage() }
                    .buttonStyle(.link)
                Hint(L("API keys, and signing out everywhere"))
            }
            VStack(alignment: .leading, spacing: 2) {
                Button(L("Delete account…"), role: .destructive) { openAccountPage() }
                    .buttonStyle(.link)
                    .foregroundStyle(Color.bad)
                Hint(L("Opens the account page, where you confirm it."))
            }
            .padding(.top, 6)
        }
    }

    private func openAccountPage() { NSWorkspace.shared.open(URL(string: "\(Api.site)/account/#account")!) }
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
                .onAppear { app.loadDestinations() }
            let q = query.trimmingCharacters(in: .whitespaces)
            // The stops your classes go to come first, before anything is typed too.
            let favourite = Set(setup.places.map(\.to))
            let timetable = Array(Set(setup.classes.map(\.to))).filter { !favourite.contains($0) }.sorted()
                .compactMap { to in app.destinations.first { $0.kind == "stop" && $0.code == to } }
            let list = q.isEmpty ? timetable : Array(rankDestinations(app.destinations, q))
            if q.isEmpty, !list.isEmpty { Hint(L("In your timetable")) }
            if !list.isEmpty {
                ForEach(list, id: \.self) { d in
                    Button {
                        query = ""
                        note = setup.addPlace(d).map { L("Already a favourite: %@", $0) }
                    } label: {
                        DestinationLabel(destination: d)
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

/// A group's heading, its rows in one box, and at most one line under them.
private struct TripsGroup<Content: View>: View {
    let title: String
    let hint: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline).accessibilityAddTraits(.isHeader)
            GroupBox {
                VStack(alignment: .leading, spacing: 10) { content }
                    .padding(6)
            }
            Hint(hint).padding(.leading, 4)
        }
    }
}

/// Your trips: where you live, your day's hours and how you walk, in three
/// short groups of one-line rows, as on the phone and the web. Setup asks
/// the same things with more words (HomeStep, PaceStep).
struct TripsPane: View {
    let setup: SetupModel
    let app: AppModel
    @State private var offCampus = false
    @State private var locating: String?

    private var residence: Campus.Residence? { setup.residence }
    private let paces = WalkPace.all

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            TripsGroup(title: L("Where you live"), hint: L("Only your stops are saved.")) { home }
            TripsGroup(title: L("Your day"), hint: L("Outside these hours, you see your next class instead of a bus.")) { day }
            TripsGroup(title: L("Walking"), hint: L("Walks follow the paths on campus.")) { walking }
        }
        .onChange(of: setup.homeStops) { offCampus = false }
    }

    @ViewBuilder private var home: some View {
        if let campus = setup.campus {
            let picking = offCampus || residence == nil
            LabeledContent(L("Residence")) {
                Picker(L("Residence"), selection: Binding(
                    get: { picking ? "" : residence!.code },
                    set: { code in
                        if let r = campus.residences.first(where: { $0.code == code }) { setup.setResidence(r) } else { offCampus = true }
                    }
                )) {
                    Text(L("Off campus")).tag("")
                    ResidenceItems(residences: campus.residences)
                }
                .labelsHidden()
                .fixedSize()
            }
            if !picking, let r = residence {
                Hint(L("Your stops: %@.", r.stops.map(campus.stopName).joined(separator: ", ")))
            } else {
                Divider()
                LabeledContent(L("Your stop")) {
                    Picker(L("Your stop"), selection: Binding(
                        get: { setup.homeStops.first ?? "" },
                        set: { setup.setFirstHomeStop($0) }
                    )) {
                        Text(L("Choose a stop")).tag("")
                        ForEach(campus.stops, id: \.code) { Text($0.name).tag($0.code) }
                    }
                    .labelsHidden()
                    .fixedSize()
                }
                HStack {
                    Button(L("Pick the stop nearest me")) {
                        locating = L("Finding the nearest stop…")
                        Task { locating = await setup.pickNearestStop(app: app, campus: campus) }
                    }
                    .buttonStyle(.link)
                    if let locating { Hint(locating) }
                }
            }
            Divider()
            LabeledContent(L("Walk to your stop")) {
                Stepper(L("%@ min", "\(setup.homeWalkMin)"), value: Binding(get: { setup.homeWalkMin }, set: { setup.setHomeWalk($0) }), in: setup.limits.homeWalkMin)
            }
        } else {
            ProgressView()
        }
    }

    @ViewBuilder private var day: some View {
        LabeledContent(L("Show buses between")) {
            HStack(spacing: 6) {
                DatePicker(L("Day starts"), selection: time(get: { setup.dayStartMin }, set: setup.setDayStart), displayedComponents: .hourAndMinute)
                    .labelsHidden()
                Text(L("and")).foregroundStyle(.secondary)
                DatePicker(L("Day ends"), selection: time(get: { setup.dayEndMin }, set: setup.setDayEnd), displayedComponents: .hourAndMinute)
                    .labelsHidden()
            }
        }
        Divider()
        LabeledContent(L("Go home in gaps longer than")) {
            let h = setup.gapHours
            let shown = h == 1 ? L("1 hour") : L("%@ hours", h.truncatingRemainder(dividingBy: 1) == 0 ? "\(Int(h))" : "\(h)")
            Stepper(shown, value: Binding(get: { setup.gapHours }, set: { setup.setGapHours($0) }), in: 0.5...12, step: 0.5)
        }
    }

    @ViewBuilder private var walking: some View {
        let pace = paces.first { $0.0 == setup.walkPace } ?? paces[1]
        LabeledContent {
            Picker(L("Walking pace"), selection: Binding(get: { pace.0 }, set: { setup.setPace($0) })) {
                ForEach(paces, id: \.0) { Text($0.1).tag($0.0) }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("Walking pace"))
                Hint(pace.2)
            }
        }
        Divider()
        LabeledContent {
            Toggle(L("Allow for busy buses"), isOn: Binding(get: { setup.fullBusMargin }, set: { setup.setFullBusMargin($0) }))
                .toggleStyle(.switch)
                .labelsHidden()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("Allow for busy buses"))
                Hint(L("Aim one bus earlier when yours is often full."))
            }
        }
        Divider()
        LabeledContent {
            Toggle(L("Public buses"), isOn: Binding(get: { setup.publicBuses }, set: { setup.setPublicBuses($0) }))
                .toggleStyle(.switch)
                .labelsHidden()
        } label: {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("Public buses"))
                Hint(L("Count the 95, 151 and other public buses at your stops too. They have a fare, so one is the answer only when it clearly saves time."))
            }
        }
    }

    /// Minutes after midnight as a time of day for a DatePicker, today on this Mac's calendar.
    private func time(get: @escaping () -> Int, set: @escaping (Int) -> Void) -> Binding<Date> {
        Binding(
            get: { Calendar.current.date(bySettingHour: get() / 60, minute: get() % 60, second: 0, of: Date()) ?? Date() },
            set: { d in
                let c = Calendar.current.dateComponents([.hour, .minute], from: d)
                set((c.hour ?? 0) * 60 + (c.minute ?? 0))
            }
        )
    }
}
