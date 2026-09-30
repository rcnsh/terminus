import AppKit
import CoreImage.CIFilterBuiltins
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

    private var api: Api { Api(token: TokenStore.read()) }

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
            profile = try object(await p)
            campus = try await c
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = "Couldn't reach terminus. Check your connection and try again."
        }
    }

    // MARK: profile fields (as profile.ts names them)

    var homeStops: [String] { (profile?["home"] as? [String: Any])?["stops"] as? [String] ?? [] }
    var homeWalkMin: Int { profile?["homeWalkMin"] as? Int ?? 5 }
    var walkPace: String { profile?["walkPace"] as? String ?? "normal" }
    var fullBusMargin: Bool { profile?["fullBusMargin"] as? Bool ?? true }
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

    func setHomeWalk(_ min: Int) { edit { $0["homeWalkMin"] = Swift.min(30, Swift.max(0, min)) } }
    func setPace(_ pace: String) { edit { $0["walkPace"] = pace } }
    func setFullBusMargin(_ on: Bool) { edit { $0["fullBusMargin"] = on } }

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
            } catch let e as ApiError {
                profile = current
                message = "Not saved: \(e.message)"
            } catch {
                profile = current
                message = "Not saved: couldn't reach terminus"
            }
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
        } catch let e as ApiError {
            message = e.message
        } catch {
            message = "Couldn't reach terminus. Check your connection and try again."
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
            message = "Couldn't reach terminus. Check your connection and try again."
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
            message = "Couldn't remove it. Try again in a moment."
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
            message = e.status == 403 ? "Add an email to your account first: devices are added to an account with one." : e.message
        } catch {
            message = "Couldn't reach terminus. Check your connection and try again."
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
                self.added = added.name ?? "Device"
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
        guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ApiError(status: 0, message: "Unexpected answer from terminus") }
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
                Text("Step \(step + 1) of \(steps)").font(.callout.weight(.medium)).foregroundStyle(.secondary)
                Spacer()
                Button("Skip setup") { finish() }.buttonStyle(.link)
            }
            ProgressView(value: Double(step + 1), total: Double(steps)).padding(.vertical, 10)

            Group {
                if setup.profile == nil {
                    VStack(spacing: 12) {
                        if let m = setup.message {
                            Text(m).foregroundStyle(.red)
                            Button("Try again") { Task { await setup.load() } }
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
                if step > 0 { Button("Back") { step -= 1 } }
                Spacer()
                Button(step + 1 >= steps ? "Done" : "Continue") { step + 1 >= steps ? finish() : (step += 1) }
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

private struct StepTitle: View {
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

private struct Hint: View {
    let text: String
    init(_ text: String) { self.text = text }
    var body: some View { Text(text).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true) }
}

/// Where do you live? A residence brings all its stops; off campus, pick one.
private struct HomeStep: View {
    let setup: SetupModel
    let app: AppModel
    @State private var offCampus = false
    @State private var locating: String?

    private var residence: Campus.Residence? { setup.campus?.residences.first { $0.stops == setup.homeStops } }

    var body: some View {
        StepTitle(title: "Where do you live?", sub: "Where you catch the bus in the morning and head back to at night. Only the stops are saved, never where you live.")
        if let campus = setup.campus {
            Picker("Residence", selection: Binding(
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
                Text("Off campus, or I'll pick a stop").tag("")
                ForEach(campus.residences, id: \.code) { Text($0.name).tag($0.code) }
            }
            if let r = residence, !offCampus {
                Hint("Stops for \(r.name): \(r.stops.map(campus.stopName).joined(separator: ", ")). terminus won't send you home when you're already there.")
            } else {
                Picker("Home stop", selection: Binding(
                    get: { setup.homeStops.first ?? "" },
                    set: { code in setup.setHomeStops([code] + setup.homeStops.dropFirst().filter { $0 != code }) }
                )) {
                    Text("Choose a stop").tag("")
                    ForEach(campus.stops, id: \.code) { Text($0.name).tag($0.code) }
                }
                Button("Pick the stop nearest me") {
                    locating = "Finding the nearest stop…"
                    Task {
                        if let loc = await app.whereAmI(), let near = campus.nearest(lat: loc.coordinate.latitude, lon: loc.coordinate.longitude) {
                            setup.setHomeStops([near.code] + setup.homeStops.filter { $0 != near.code })
                            locating = "Picked \(near.name). Change it if you use a different stop."
                        } else {
                            locating = "Couldn't get this Mac's location. Pick your stop instead."
                        }
                    }
                }
                .buttonStyle(.link)
                if let locating { Hint(locating) }
            }
            Stepper("Walk from home to your stop: \(setup.homeWalkMin) min", value: Binding(get: { setup.homeWalkMin }, set: { setup.setHomeWalk($0) }), in: 0...30)
                .padding(.top, 6)
            Hint("Counted in your leave-by time when terminus doesn't have your location.")
        } else {
            ProgressView()
        }
    }
}

private struct TimetableStep: View {
    let setup: SetupModel
    @State private var link = ""

    var body: some View {
        Group { content }.onAppear { if link.isEmpty { link = setup.share ?? "" } }
    }

    @ViewBuilder private var content: some View {
        StepTitle(title: "Your timetable", sub: "Paste your NUSMods share link. Each class goes to the stop nearest its room.")
        TextField("https://nusmods.com/timetable/sem-1/share?…", text: $link)
            .textFieldStyle(.roundedBorder)
            .onSubmit { Task { await setup.importTimetable(link) } }
        Hint("In NUSMods: Timetable, then Share/Sync. Copy the link and paste it here.")
        Button(setup.importing ? "Importing…" : "Import") { Task { await setup.importTimetable(link) } }
            .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty || setup.importing)
        if let r = setup.imported {
            Text("Imported \(r.classes) class\(r.classes == 1 ? "" : "es") for \(r.term).")
            if !r.unresolved.isEmpty { Hint("No stop found for \(r.unresolved.joined(separator: "; ")). Add those by hand on the account page.") }
            if !r.missing.isEmpty { Hint("NUSMods has no classes this semester for \(r.missing.joined(separator: ", ")).") }
        } else if setup.importedClasses > 0 {
            Hint("\(setup.importedClasses) classes imported.")
        }
    }
}

private struct PaceStep: View {
    let setup: SetupModel
    private let paces = [
        ("slow", "Slow", "400 m in about 6 min. Unhurried, or you often have a bag to carry."),
        ("normal", "Normal", "400 m in about 5 min. Most people."),
        ("fast", "Fast", "400 m in about 4 min. You're the one overtaking."),
    ]

    var body: some View {
        StepTitle(title: "How you get around", sub: "Walks follow the real paths on campus. Your pace sets how long they take.")
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
                Text("Allow for packed buses")
                Hint("When the bus you'd wait for is often full at that stop and time, aim one bus earlier.")
            }
        }
        .padding(.top, 6)
    }
}

/// Notifications and location, each with what it's for, each skippable.
private struct PermissionsStep: View {
    @Bindable var app: AppModel

    var body: some View {
        StepTitle(title: "Two last things", sub: "Both are optional. You can change them later in Settings.")
        Text("Notifications").font(.headline)
        Text("A heads-up 5 minutes before you need to leave for class, and \"On the 9:41 D2?\" when your bus leaves.")
            .fixedSize(horizontal: false, vertical: true)
        if app.leaveAlerts { Hint("On.") } else { Button("Turn on leave-by alerts") { app.setLeaveAlerts(true) } }
        Text("Location").font(.headline).padding(.top, 10)
        Text("So answers start from the stop you're nearest. It's used for that answer only, rounded to about 11 m, and never saved.")
            .fixedSize(horizontal: false, vertical: true)
        if app.needsLocation {
            Button("Allow location") { app.askLocation() }
        } else if app.locationDenied {
            Button("Open Location settings") { app.openLocationSettings() }
        } else {
            Hint("Allowed.")
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
            Text("Devices").font(.title2.weight(.semibold))
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
                            Text(d.name ?? "Device") + Text(d.current == true ? "  This Mac" : "").foregroundColor(.secondary)
                            Hint([platform(d.platform), d.lastSeen.map { "last used \(Date(timeIntervalSince1970: $0 / 1000).formatted(.relative(presentation: .named)))" }].compactMap { $0 }.joined(separator: " · "))
                        }
                        Spacer()
                        if d.current != true {
                            Button("Remove") { Task { await setup.remove(d) } }.disabled(setup.busy)
                        }
                    }
                    .padding(.vertical, 2)
                }
                Hint("Removing a device signs it out. You're emailed about every device added or removed.")
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            Button("Add a device…") { Task { await setup.newPairCode() } }.disabled(setup.busy)
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

    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .font(.system(size: 64))
                .foregroundStyle(.white, .green)
                .scaleEffect(shown ? 1 : 0.4)
                .opacity(shown ? 1 : 0)
            Text("\(name) added").font(.headline)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .onAppear { withAnimation(.spring(response: 0.35, dampingFraction: 0.6)) { shown = true } }
        .accessibilityElement(children: .combine)
    }
}

/// The code to type on another device, and a QR code a phone's camera opens.
private struct PairCodeCard: View {
    let code: String
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 8) {
            Text("On the other device, open terminus and enter:")
            Text("\(code.prefix(3)) \(code.dropFirst(3))").font(.system(size: 30, weight: .bold, design: .monospaced)).textSelection(.enabled)
            Text("Or scan this with a phone's camera:").font(.callout)
            if let qr = qrImage("https://terminus.rcn.sh/pair?code=\(code)") {
                Image(nsImage: qr).interpolation(.none).resizable().frame(width: 160, height: 160)
                    .accessibilityLabel("QR code for pairing code \(code)")
            }
            Hint("Works once, for 10 minutes.")
            Button("Done", action: onDone)
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
