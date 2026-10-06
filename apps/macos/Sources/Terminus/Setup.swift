import AppKit
import CoreImage.CIFilterBuiltins
import UniformTypeIdentifiers
import Observation
import SwiftUI

/// The account's setup, edited from the Mac (phase 7): the same four steps as
/// the phone's onboarding, and the devices on the account. Everything goes
/// through the routes the account page uses, with this Mac's token.
@MainActor
@Observable
final class SetupModel {
    /// The profile as the server keeps it; unknown fields survive a save.
    private(set) var profile: [String: Any]?
    private(set) var campus: Campus?
    var message: String?
    private(set) var importing = false
    private(set) var imported: ImportResult?
    private(set) var devices: [Device]?
    private(set) var pairCode: String?
    private(set) var busy = false
    /// Imported classes whose room couldn't be placed, until each gets a stop or is skipped.
    private(set) var unplaced: [Unplaced] = []
    /// Who's signed in (/me): the email, and whether the timetable needs importing again.
    private(set) var me: Me?
    /// Classes with a bus earlier or no reminders, and the trips remembered (/me/choices).
    private(set) var choices: Choices?

    private var api: Api { Api(token: TokenStore.read()) }

    /// After each save: the popover's favourites (its tabs) follow.
    var onSaved: @MainActor () -> Void = {}

    init() {}

    #if DEBUG
    /// Filled in, for snapshot renders.
    init(profile: [String: Any], campus: Campus, devices: [Device]? = nil, pairCode: String? = nil) {
        self.profile = profile
        self.campus = campus
        self.devices = devices
        self.pairCode = pairCode
    }
    #endif

    func load() async {
        message = nil
        do {
            async let p = api.profile()
            async let c = api.campus()
            async let m = try? api.me()
            async let ch = try? api.choices()
            profile = try object(await p)
            Clock.pref = clock
            campus = try await c
            me = await m
            choices = await ch
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = L("Couldn't reach terminus. Check your connection and try again.")
        }
    }

    // MARK: profile fields (as profile.ts names them)

    var homeStops: [String] { (profile?["home"] as? [String: Any])?["stops"] as? [String] ?? [] }
    var homeWalkMin: Int { profile?["homeWalkMin"] as? Int ?? 5 }
    var walkPace: String { profile?["walkPace"] as? String ?? "normal" }
    /// auto (each device's own), 12 or 24.
    var clock: String { profile?["clock"] as? String ?? "auto" }
    var fullBusMargin: Bool { profile?["fullBusMargin"] as? Bool ?? true }
    /// Count the public buses (95, 151, ...) at the campus's stops too. Off until asked for: they have a fare.
    var publicBuses: Bool { profile?["publicBuses"] as? Bool ?? false }
    /// The day's hours, in minutes after midnight, and the gap long enough to go home in.
    var dayStartMin: Int { profile?["dayStartMin"] as? Int ?? 360 }
    var dayEndMin: Int { profile?["dayEndMin"] as? Int ?? 1080 }
    var gapHours: Double { (profile?["gapHours"] as? NSNumber)?.doubleValue ?? 2 }
    var share: String? { profile?["share"] as? String }
    var importedClasses: Int { (profile?["trips"] as? [Any])?.count ?? 0 }

    func setHomeStops(_ stops: [String]) {
        var unique: [String] = []
        for s in stops where !unique.contains(s) { unique.append(s) }
        edit { $0["home"] = unique.isEmpty ? NSNull() : ["stops": Array(unique.prefix(3))] }
    }

    func setResidence(_ r: Campus.Residence) {
        // The residence's walk at a normal pace, as the phone and the account page set it.
        edit {
            $0["home"] = ["stops": r.stops]
            $0["homeWalkMin"] = max(1, Int(((r.walkM ?? 0) / 1.3 / 60).rounded()))
        }
    }

    /// Favourites, as the profile keeps them: key, label, and the stop (or food court) they go to.
    var places: [(key: String, label: String, to: String)] {
        (profile?["places"] as? [[String: Any]] ?? []).compactMap { p in
            guard let key = p["key"] as? String, let label = p["label"] as? String, let to = p["to"] as? String else { return nil }
            return (key, label, to)
        }
    }

    /// The account's limit (PROFILE_LIMITS.places in the API).
    static let maxPlaces = 12

    /**
     A favourite from a search result, called what was picked, short, as it
     reads on a button: a building or room by its code ("COM1"), anything
     else by its name. One per stop. Returns the existing one's label if the
     stop is already a favourite.
     */
    @discardableResult
    func addPlace(_ d: Destination) -> String? {
        let to = d.kind == "landmark" ? d.code : d.stopCode
        if let same = places.first(where: { $0.to == to }) { return same.label }
        let label = String((d.kind == "building" || d.kind == "room" ? d.code : d.label).prefix(24))
        let slug = label.lowercased().replacingOccurrences(of: "[^a-z0-9]+", with: "-", options: .regularExpression).trimmingCharacters(in: CharacterSet(charactersIn: "-"))
        var key = String(slug.prefix(24)).isEmpty ? "place" : String(slug.prefix(24))
        while places.contains(where: { $0.key == key }) { key = "\(key.prefix(21))-\(Int.random(in: 10...99))" }
        edit {
            var list = $0["places"] as? [[String: Any]] ?? []
            list.append(["key": key, "label": label, "to": to])
            $0["places"] = list
        }
        return nil
    }

    /// A favourite gone, with its usual times.
    func removePlace(_ key: String) {
        edit {
            $0["places"] = ($0["places"] as? [[String: Any]] ?? []).filter { $0["key"] as? String != key }
            $0["usual"] = ($0["usual"] as? [[String: Any]] ?? []).filter { $0["place"] as? String != key }
        }
    }

    func setHomeWalk(_ min: Int) { edit { $0["homeWalkMin"] = Swift.min(30, Swift.max(0, min)) } }
    func setPace(_ pace: String) { edit { $0["walkPace"] = pace } }
    func setFullBusMargin(_ on: Bool) { edit { $0["fullBusMargin"] = on } }
    func setPublicBuses(_ on: Bool) { edit { $0["publicBuses"] = on } }
    /// The start stays before the end; a change that would cross them is refused.
    func setDayStart(_ min: Int) { if min < dayEndMin { edit { $0["dayStartMin"] = min } } }
    func setDayEnd(_ min: Int) { if min > dayStartMin { edit { $0["dayEndMin"] = min } } }
    func setGapHours(_ h: Double) { edit { $0["gapHours"] = Swift.min(12, Swift.max(0.5, h)) } }
    /// Times on every device; the menu bar follows at once, the card once saved.
    func setClock(_ pref: String) {
        Clock.pref = pref
        edit { $0["clock"] = pref }
    }

    /// Changes shown at once, saved in the background, put back if the save fails.
    func edit(_ change: (inout [String: Any]) -> Void) {
        guard let current = profile else { return }
        var next = current
        change(&next)
        profile = next
        guard let body = try? JSONSerialization.data(withJSONObject: next) else { return }
        Task {
            do {
                profile = try object(await api.saveProfile(body))
                message = nil
                onSaved()
            } catch let e as ApiError {
                profile = current
                message = L("Not saved: %@", e.message)
            } catch {
                profile = current
                message = L("Not saved: couldn't reach terminus")
            }
        }
    }

    // MARK: the timetable, class by class

    /// A class as the profile keeps it, imported (`trips`) or added by hand (`manual`), by its place in that list.
    struct Class: Identifiable {
        let list: String
        let index: Int
        let day: Int
        let arriveByMin: Int
        let endMin: Int?
        let to: String
        let label: String
        let weeks: [Int]?
        var id: String { "\(list)-\(index)" }
    }

    var classes: [Class] {
        ["trips", "manual"].flatMap { list in
            (profile?[list] as? [[String: Any]] ?? []).enumerated().compactMap { i, c -> Class? in
                guard let day = c["day"] as? Int, let at = c["arriveByMin"] as? Int, let to = c["to"] as? String else { return nil }
                return Class(list: list, index: i, day: day, arriveByMin: at, endMin: c["endMin"] as? Int, to: to, label: c["label"] as? String ?? "", weeks: c["weeks"] as? [Int])
            }
        }
    }

    func setClassStop(_ c: Class, to: String) {
        edit {
            var list = $0[c.list] as? [[String: Any]] ?? []
            guard list.indices.contains(c.index) else { return }
            list[c.index]["to"] = to
            $0[c.list] = list
        }
    }

    func removeClass(_ c: Class) {
        edit {
            var list = $0[c.list] as? [[String: Any]] ?? []
            guard list.indices.contains(c.index) else { return }
            list.remove(at: c.index)
            $0[c.list] = list
        }
    }

    /// "Add a class or commitment by hand"; it survives a re-import.
    func addManual(day: Int, at: Int, end: Int?, to: String, label: String, venue: String = "") {
        edit {
            var list = $0["manual"] as? [[String: Any]] ?? []
            var c: [String: Any] = ["day": day, "arriveByMin": at, "to": to, "label": label, "venue": venue]
            if let end, end > at { c["endMin"] = end }
            list.append(c)
            $0["manual"] = list
        }
    }

    /// A favourite at its usual time each week (from before favourites lost them), with its place.
    var usual: [(place: String, day: Int, atMin: Int, label: String, to: String)] {
        (profile?["usual"] as? [[String: Any]] ?? []).compactMap { u in
            guard let key = u["place"] as? String, let day = u["day"] as? Int, let at = u["atMin"] as? Int, let p = places.first(where: { $0.key == key }) else { return nil }
            return (key, day, at, p.label, p.to)
        }
    }

    func removeUsual(place: String, day: Int, atMin: Int) {
        edit { $0["usual"] = ($0["usual"] as? [[String: Any]] ?? []).filter { !($0["place"] as? String == place && $0["day"] as? Int == day && $0["atMin"] as? Int == atMin) } }
    }

    /// An unplaced class given a stop: added by hand there, as the account page does.
    func place(_ u: Unplaced, to: String) {
        addManual(day: u.day, at: u.arriveByMin, end: u.endMin, to: to, label: "\(u.module) @ \(u.venue.split(separator: "-").first.map(String.init) ?? u.venue)", venue: u.venue)
        skip(u)
    }

    func skip(_ u: Unplaced) { unplaced.removeAll { $0 == u } }

    // MARK: trip choices and history (phase 3)

    func loadChoices() async { choices = try? await api.choices() }

    func undoChoice(_ c: TripChoice) async {
        do {
            try await api.undoChoice(trip: c.trip, pref: c.pref)
            await loadChoices()
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = L("Couldn't reach terminus. Check your connection and try again.")
        }
    }

    func clearHistory() async {
        do {
            try await api.clearHistory()
            await loadChoices()
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = L("Couldn't reach terminus. Check your connection and try again.")
        }
    }

    // MARK: feedback, your data

    /// Send feedback; nil once sent, else why not.
    func sendFeedback(_ note: String) async -> String? {
        do {
            try await api.feedback(note: note.trimmingCharacters(in: .whitespacesAndNewlines))
            return nil
        } catch let e as ApiError {
            return e.message
        } catch {
            return L("Couldn't reach terminus. Try again in a moment.")
        }
    }

    /// Download my data: the export, saved where the person picks.
    func export() async {
        do {
            let data = try await api.export()
            let panel = NSSavePanel()
            panel.nameFieldStringValue = "terminus-export.json"
            panel.allowedContentTypes = [.json]
            NSApp.activate()
            guard panel.runModal() == .OK, let url = panel.url else { return }
            try data.write(to: url)
            message = nil
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = L("Couldn't save your data. %@", error.localizedDescription)
        }
    }

    func importTimetable(_ link: String) async {
        let share = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !share.isEmpty, !importing else { return }
        importing = true
        imported = nil
        message = nil
        defer { importing = false }
        do {
            let r = ImportResult(try object(await api.importTimetable(share)))
            imported = r
            profile = r.profile
            unplaced = r.unplaced
            me = try? await api.me()
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = L("Couldn't reach terminus. Check your connection and try again.")
        }
    }

    /// Setup done (or skipped): the account page and the apps stop offering it.
    func finish() {
        guard let profile else { return }
        var seen = profile["seen"] as? [String] ?? []
        guard !seen.contains("onboarding") else { return }
        seen.append("onboarding")
        edit { $0["seen"] = seen }
    }

    // MARK: devices

    func loadDevices() async {
        do {
            devices = try await api.devices()
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = L("Couldn't reach terminus. Check your connection and try again.")
        }
    }

    func remove(_ d: Device) async {
        busy = true
        defer { busy = false }
        do {
            try await api.removeDevice(d.id)
            devices?.removeAll { $0.id == d.id }
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = L("Couldn't remove it. Try again in a moment.")
        }
    }

    func newPairCode() async {
        busy = true
        defer { busy = false }
        do {
            pairCode = try await api.pairCode()
            message = nil
        } catch let e as ApiError {
            // 403: an account without an email can't add devices.
            message = e.status == 403 ? L("Add an email to your account first. Devices can only be added to an account with an email.") : e.message
        } catch {
            message = L("Couldn't reach terminus. Check your connection and try again.")
        }
    }

    /// While the code is showing, checks every few seconds for a device
    /// that wasn't there before, and goes back to the list once one is.
    /// Cancelled with the card (Done, or the window closing).
    /// The device just paired, while its tick shows.
    var added: String?

    func waitForNewDevice() async {
        let known = Set((devices ?? []).map(\.id))
        let code = pairCode
        while !Task.isCancelled, pairCode == code {
            try? await Task.sleep(for: .seconds(3))
            guard !Task.isCancelled, pairCode == code, let now = try? await api.devices() else { continue }
            if let added = now.first(where: { !known.contains($0.id) }) {
                // A tick over the code for a moment, then back to the list.
                self.added = added.name ?? L("Device")
                try? await Task.sleep(for: .seconds(1.2))
                devices = now
                pairCode = nil
                self.added = nil
                return
            }
        }
    }

    /// Back to the list, fetched again: the code may just have added a device.
    func closePairCode() async {
        pairCode = nil
        await loadDevices()
    }

    private func object(_ data: Data) throws -> [String: Any] {
        guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ApiError(status: 0, message: L("Unexpected response from terminus")) }
        return o
    }
}

// MARK: - Setup window

/// "Set up terminus": home, timetable, pace, then notifications and location.
/// Each step saves as it goes and can be skipped; so can the lot.
struct SetupView: View {
    @Bindable var app: AppModel
    @State private var setup: SetupModel
    @State private var step: Int
    @Environment(\.dismissWindow) private var dismissWindow
    private let steps = 4

    init(app: AppModel, setup: SetupModel = SetupModel(), step: Int = 0) {
        self.app = app
        _setup = State(initialValue: setup)
        _step = State(initialValue: step)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(L("Step %@ of %@", "\(step + 1)", "\(steps)")).font(.callout.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                Button(L("Skip setup")) { finish() }.buttonStyle(.link)
            }
            ProgressView(value: Double(step + 1), total: Double(steps)).padding(.vertical, 10)

            Group {
                if setup.profile == nil {
                    VStack(spacing: 12) {
                        if let m = setup.message {
                            Text(m).foregroundStyle(.red)
                            Button(L("Try again")) { Task { await setup.load() } }
                        } else {
                            ProgressView()
                        }
                    }
                    .frame(maxWidth: .infinity, minHeight: 240)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 12) {
                            switch step {
                            case 0: HomeStep(setup: setup, app: app)
                            case 1: TimetableStep(setup: setup)
                            case 2: PaceStep(setup: setup)
                            default: PermissionsStep(app: app)
                            }
                            if let m = setup.message { Text(m).font(.callout).foregroundStyle(.red) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, 4)
                    }
                }
            }
            .frame(maxHeight: .infinity, alignment: .top)

            HStack {
                if step > 0 { Button(L("Back")) { step -= 1 } }
                Spacer()
                Button(step + 1 >= steps ? L("Done") : L("Continue")) { step + 1 >= steps ? finish() : (step += 1) }
                    .keyboardShortcut(.defaultAction)
                    .disabled(setup.profile == nil || setup.importing)
            }
            .padding(.top, 12)
        }
        .padding(20)
        .frame(width: 460, height: 540)
        .task { if setup.profile == nil { await setup.load() } }
    }

    private func finish() {
        setup.finish()
        app.needsSetup = false
        Task { await app.refresh() }
        dismissWindow(id: "setup")
    }
}

struct StepTitle: View {
    let title: String
    let sub: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title).font(.title2.weight(.semibold))
            Text(sub).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.bottom, 4)
    }
}

struct Hint: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
}

/// Where do you live? A residence brings all its stops; off campus, pick one.
struct HomeStep: View {
    let setup: SetupModel
    let app: AppModel
    @State private var offCampus = false
    @State private var locating: String?

    private var residence: Campus.Residence? { setup.campus?.residences.first { $0.stops == setup.homeStops } }

    var body: some View {
        StepTitle(title: L("Where do you live?"), sub: L("Where you catch the bus in the morning and head back to at night. Only the stops are saved, never where you live."))
        if let campus = setup.campus {
            Picker(L("Residence"), selection: Binding(
                get: { offCampus || residence == nil ? "" : residence!.code },
                set: { code in
                    if let r = campus.residences.first(where: { $0.code == code }) {
                        offCampus = false
                        setup.setResidence(r)
                    } else {
                        offCampus = true
                    }
                }
            )) {
                Text(L("Off campus, or I'll pick a stop")).tag("")
                ForEach(campus.residences, id: \.code) { Text($0.name).tag($0.code) }
            }
            if let r = residence, !offCampus {
                Hint(L("Stops for %@: %@. terminus won't direct you home when you're already there.", r.name, r.stops.map(campus.stopName).joined(separator: ", ")))
            } else {
                Picker(L("Home stop"), selection: Binding(
                    get: { setup.homeStops.first ?? "" },
                    // "Choose a stop" clears the first one rather than saving a blank stop.
                    set: { code in setup.setHomeStops((code.isEmpty ? [] : [code]) + setup.homeStops.dropFirst().filter { $0 != code }) }
                )) {
                    Text(L("Choose a stop")).tag("")
                    ForEach(campus.stops, id: \.code) { Text($0.name).tag($0.code) }
                }
                Button(L("Pick the stop nearest me")) {
                    locating = L("Finding the nearest stop…")
                    Task {
                        if let loc = await app.whereAmI(), let near = campus.nearest(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude) {
                            setup.setHomeStops([near.code] + setup.homeStops.filter { $0 != near.code })
                            locating = L("Picked %@. Change it if you use a different stop.", near.name)
                        } else {
                            locating = L("Couldn't get this Mac's location. Pick your stop instead.")
                        }
                    }
                }
                .buttonStyle(.link)
                if let locating { Hint(locating) }
            }
            Stepper(L("Walk from home to your stop: %@ min", "\(setup.homeWalkMin)"), value: Binding(get: { setup.homeWalkMin }, set: { setup.setHomeWalk($0) }), in: 0...30)
                .padding(.top, 6)
            Hint(L("Included in your departure time when your location isn't available."))
        } else {
            ProgressView()
        }
    }
}

struct TimetableStep: View {
    let setup: SetupModel
    @State private var link = ""

    var body: some View {
        Group { content }.onAppear { if link.isEmpty { link = setup.share ?? "" } }
    }

    @ViewBuilder private var content: some View {
        StepTitle(title: L("Your timetable"), sub: L("Paste your NUSMods share link. Each class goes to the stop nearest its room."))
        TextField("https://nusmods.com/timetable/sem-1/share?…", text: $link)
            .textFieldStyle(.roundedBorder)
            .onSubmit { Task { await setup.importTimetable(link) } }
        Hint(L("In NUSMods: Timetable, then Share/Sync. Copy the link and paste it here."))
        Button(setup.importing ? L("Importing…") : L("Import")) { Task { await setup.importTimetable(link) } }
            .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty || setup.importing)
        if let r = setup.imported {
            Text(r.classes == 1 ? L("Imported 1 class for %@.", r.term) : L("Imported %@ classes for %@.", "\(r.classes)", r.term))
            UnplacedList(setup: setup)
            if !r.missing.isEmpty { Hint(L("NUSMods has no classes this semester for %@.", r.missing.joined(separator: ", "))) }
        } else if setup.importedClasses > 0 {
            Hint(setup.importedClasses == 1 ? L("1 class imported.") : L("%@ classes imported.", "\(setup.importedClasses)"))
        }
    }
}

struct PaceStep: View {
    let setup: SetupModel
    private let paces = [
        ("slow", L("Slow"), L("400 m in about 6 min. A relaxed pace, or if you often carry a bag.")),
        ("normal", L("Normal"), L("400 m in about 5 min. An average pace.")),
        ("fast", L("Fast"), L("400 m in about 4 min. A brisk pace.")),
    ]

    var body: some View {
        StepTitle(title: L("How you get around"), sub: L("Walks follow the real paths on campus. Your pace sets how long they take."))
        ForEach(paces, id: \.0) { value, title, hint in
            let on = setup.walkPace == value
            Button { setup.setPace(value) } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.headline)
                    Hint(hint)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(10)
                .background(RoundedRectangle(cornerRadius: 10).fill(on ? Color.brand.opacity(0.12) : Color.primary.opacity(0.04)))
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(on ? Color.brand : Color.primary.opacity(0.1), lineWidth: on ? 2 : 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(on ? [.isSelected] : [])
        }
        Toggle(isOn: Binding(get: { setup.fullBusMargin }, set: { setup.setFullBusMargin($0) })) {
            VStack(alignment: .leading, spacing: 2) {
                Text(L("Allow for busy buses"))
                Hint(L("When the bus you'd wait for is often full at that stop and time, aim one bus earlier."))
            }
        }
        .padding(.top, 6)
        // Untouched, this Mac's own style is the one shown picked.
        Picker(L("Show times as"), selection: Binding(get: { setup.clock != "auto" ? setup.clock : (usesHour12 ? "12" : "24") }, set: { setup.setClock($0) })) {
            Text(L("12-hour (%@)", L("6:36 PM"))).tag("12")
            Text(L("24-hour (%@)", "18:36")).tag("24")
        }
        .pickerStyle(.radioGroup)
        .padding(.top, 6)
    }
}

/// Notifications and location, each with what it's for, each skippable.
private struct PermissionsStep: View {
    @Bindable var app: AppModel

    var body: some View {
        StepTitle(title: L("Two more things"), sub: L("Both are optional. You can change them later in Settings."))
        Text(L("Notifications")).font(.headline)
        Text(L("A reminder 5 minutes before you need to leave for class, and another when it's time to go."))
            .fixedSize(horizontal: false, vertical: true)
        if app.leaveAlerts { Hint(L("On.")) } else { Button(L("Turn on leave-by alerts")) { app.setLeaveAlerts(true) } }
        Text(L("Location")).font(.headline).padding(.top, 10)
        Text(L("So directions start from your nearest stop. Your location is used only for that request, rounded to about 11 m, and never stored."))
            .fixedSize(horizontal: false, vertical: true)
        if app.needsLocation {
            Button(L("Allow location")) { app.askLocation() }
        } else if app.locationDenied {
            Button(L("Open Location settings")) { app.openLocationSettings() }
        } else {
            Hint(L("Allowed."))
        }
    }
}

// MARK: - Devices window

/// The devices on the account: remove one, or add one with a code and a QR code.
struct DevicesView: View {
    @State private var setup: SetupModel

    init(setup: SetupModel = SetupModel()) { _setup = State(initialValue: setup) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("Devices")).font(.title2.weight(.semibold))
            // The code takes the list's place, so the window keeps its size.
            if let code = setup.pairCode {
                PairCodeCard(code: code) { Task { await setup.closePairCode() } }
                    .transition(.opacity)
                    .task(id: code) { await setup.waitForNewDevice() }
                    .overlay { if let name = setup.added { AddedTick(name: name).transition(.opacity) } }
                    .animation(.easeOut(duration: 0.2), value: setup.added)
            } else {
                deviceList.transition(.opacity)
            }
            if let m = setup.message { Text(m).font(.callout).foregroundStyle(.red) }
        }
        .animation(.easeInOut(duration: 0.15), value: setup.pairCode)
        .padding(20)
        .frame(width: 440, height: 540, alignment: .top)
        .task { if setup.devices == nil { await setup.loadDevices() } }
    }

    @ViewBuilder private var deviceList: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let devices = setup.devices {
                List(devices) { d in
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(d.name ?? L("Device")) + Text(d.current == true ? "  " + L("This Mac") : "").foregroundColor(.secondary)
                            Hint([platform(d.platform), d.lastSeen.map { L("last used %@", Date(timeIntervalSince1970: $0 / 1000).formatted(.relative(presentation: .named).locale(Lang.locale))) }].compactMap { $0 }.joined(separator: " · "))
                        }
                        Spacer()
                        if d.current != true {
                            Button(L("Remove")) { Task { await setup.remove(d) } }.disabled(setup.busy)
                        }
                    }
                    .padding(.vertical, 2)
                }
                Hint(L("Removing a device signs it out. You'll get an email whenever a device is added or removed."))
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Button(L("Add a device…")) { Task { await setup.newPairCode() } }.disabled(setup.busy)
        }
    }

    private func platform(_ p: String?) -> String? {
        switch p {
        case "android": "Android"
        case "mac": "Mac"
        case "ios": "iPhone"
        default: nil
        }
    }
}

/// Over the code once it's been used: a tick that springs in, and the device's name.
private struct AddedTick: View {
    let name: String
    @State private var shown = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.white, .green)
                // With reduced motion it fades in rather than springing.
                .scaleEffect(shown || reduceMotion ? 1 : 0.4)
                .opacity(shown ? 1 : 0)
            Text(L("%@ added", name)).font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onAppear { withAnimation(reduceMotion ? .easeOut(duration: 0.2) : .spring(response: 0.35, dampingFraction: 0.6)) { shown = true } }
        .accessibilityElement(children: .combine)
    }
}

/// The code to type on another device, and a QR code a phone's camera opens.
private struct PairCodeCard: View {
    let code: String
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Text(L("On the other device, open terminus and enter:"))
            Text("\(code.prefix(3)) \(code.dropFirst(3))").font(.system(size: 30, weight: .bold, design: .monospaced)).textSelection(.enabled)
            Text(L("Or scan this with a phone's camera:")).font(.callout)
            if let qr = qrImage("\(Api.site)/pair?code=\(code)") {
                Image(nsImage: qr).interpolation(.none).resizable().frame(width: 160, height: 160)
                    .accessibilityLabel(L("QR code for pairing code %@", code))
            }
            Hint(L("Works once, for 10 minutes."))
            Button(L("Done"), action: onDone)
        }
        .frame(maxWidth: .infinity)
        .card()
    }

    /// Black on white with a quiet zone, whatever the theme: cameras read it best.
    private func qrImage(_ text: String) -> NSImage? {
        let f = CIFilter.qrCodeGenerator()
        f.message = Data(text.utf8)
        f.correctionLevel = "M"
        guard let out = f.outputImage?.transformed(by: CGAffineTransform(scaleX: 8, y: 8)) else { return nil }
        let framed = out.transformed(by: CGAffineTransform(translationX: 16, y: 16))
            .composited(over: CIImage(color: .white).cropped(to: out.extent.insetBy(dx: -16, dy: -16).offsetBy(dx: 16, dy: 16)))
        guard let cg = CIContext().createCGImage(framed, from: framed.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
    }
}
