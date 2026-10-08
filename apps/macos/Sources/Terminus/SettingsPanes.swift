import AppKit
import SwiftUI

// Settings' fuller pages, as on the web and the phone: the timetable class by
// class, your classes and trip history, About, Send feedback, and adding an
// email to an account that has none.

/// "9:00 AM" or "09:00" for minutes after midnight, in the account's clock style.
func clockMin(_ min: Int) -> String {
    let f = DateFormatter()
    f.locale = Lang.locale
    f.timeZone = TimeZone(identifier: "UTC")!
    f.setLocalizedDateFormatFromTemplate(usesHour12 ? "hmm" : "HHmm")
    return f.string(from: Date(timeIntervalSince1970: TimeInterval(min * 60)))
}

/// "Mon", in the app's language; `day` is 0 for Sunday, as the profile keeps it.
func dayShort(_ day: Int) -> String { weekday(day, short: true) }

/// "Monday", as `dayShort`.
func dayLong(_ day: Int) -> String { weekday(day, short: false) }

private func weekday(_ day: Int, short: Bool) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.locale = Lang.locale
    return (short ? cal.shortWeekdaySymbols : cal.weekdaySymbols)[((day % 7) + 7) % 7]
}

/// Monday first, as the week reads.
let dayOrder = [1, 2, 3, 4, 5, 6, 0]

/// A menu of every stop: where a class goes, or a stop for one the import couldn't place.
struct StopMenu: View {
    let campus: Campus
    let label: String
    let selection: String
    var blank: String? = nil
    let onPick: (String) -> Void

    var body: some View {
        Picker(label, selection: Binding(get: { selection }, set: { if !$0.isEmpty { onPick($0) } })) {
            if let blank { Text(blank).tag("") }
            // A food court the class goes to already, kept rather than shown blank.
            if !selection.isEmpty, !campus.stops.contains(where: { $0.code == selection }) { Text(selection).tag(selection) }
            ForEach(campus.stops, id: \.code) { Text($0.name).tag($0.code) }
        }
        .labelsHidden()
        .fixedSize()
        .accessibilityLabel(label)
    }
}

/// Classes from an import whose room couldn't be placed: a stop for each, or Skip.
struct UnplacedList: View {
    let setup: SetupModel

    var body: some View {
        if !setup.unplaced.isEmpty, let campus = setup.campus {
            VStack(alignment: .leading, spacing: 6) {
                let n = setup.unplaced.count
                Text(n == 1 ? L("1 class had a venue we couldn't place. Pick the nearest stop, or skip it:") : L("%@ classes had a venue we couldn't place. Pick the nearest stop, or skip it:", "\(n)"))
                    .foregroundStyle(Color.warn)
                    .fixedSize(horizontal: false, vertical: true)
                ForEach(setup.unplaced, id: \.self) { u in
                    HStack {
                        Text("\(dayShort(u.day)) \(clockMin(u.arriveByMin)) · \(u.module) @ \(u.venue)\(u.offCampus ? L(" (off campus)") : "")")
                        Spacer()
                        StopMenu(campus: campus, label: L("Stop for %@", u.module), selection: "", blank: L("Choose stop")) { setup.place(u, to: $0) }
                        Button(L("Skip")) { setup.skip(u) }.buttonStyle(.link)
                    }
                }
            }
        }
    }
}

/// The timetable, as on the web: each class by day with its stop and Remove,
/// "Add a class or commitment by hand", then the import, folded away once
/// there are classes unless it's needed.
struct TimetablePane: View {
    @Bindable var app: AppModel
    let setup: SetupModel
    @State private var link = ""
    @State private var importOpen = false
    @State private var adding = false
    @Environment(\.settingsScroll) private var scroll
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if setup.me?.needsReimport == true {
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("Re-import your timetable.")).fontWeight(.semibold)
                    Text(L("This link is for %@, which has ended. Copy this semester's link from NUSMods and import it below.", setup.me?.term ?? ""))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .card(padding: 10)
            }
            if let m = summary { Hint(m) }
            UnplacedList(setup: setup)
            classes
            DisclosureGroup(L("Add a class or commitment by hand"), isExpanded: $adding) {
                AddClassForm(app: app, setup: setup) { adding = false }.padding(.top, 6)
            }
            .id(Self.addID)
            // It opens below the list, often past the window's edge: scroll just
            // far enough to show all of it, once it has opened.
            .onChange(of: adding) { _, open in
                guard open else { return }
                Task {
                    try? await Task.sleep(for: .milliseconds(200))
                    withAnimation(reduceMotion ? nil : .default) { scroll?.scrollTo(Self.addID) }
                }
            }
            DisclosureGroup(L("Import from NUSMods"), isExpanded: $importOpen) {
                VStack(alignment: .leading, spacing: 6) {
                    TextField(L("NUSMods share link"), text: $link, prompt: Text(verbatim: "https://nusmods.com/timetable/sem-1/share?…"))
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await setup.importTimetable(link) } }
                    HStack {
                        Button(setup.importing ? L("Importing…") : L("Import")) { Task { await setup.importTimetable(link) } }
                            .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty || setup.importing)
                        Hint(L("In NUSMods: Timetable, then Share/Sync. Copy the link and paste it here. Re-import each semester."))
                    }
                    if let r = setup.imported {
                        Text(r.summary)
                        if let m = r.missingText { Hint(m) }
                    }
                }
                .padding(.top, 6)
            }
        }
        .onAppear {
            if link.isEmpty { link = setup.share ?? "" }
            importOpen = setup.classes.isEmpty || setup.me?.needsReimport == true
        }
    }

    private static let addID = "add-class"

    private var summary: String? {
        let n = setup.classes.count
        guard n > 0 else { return nil }
        let count = n == 1 ? L("1 class") : L("%@ classes", "\(n)")
        if let term = setup.me?.term, setup.importedClasses > 0 { return "\(count) · \(term)" }
        return count
    }

    @ViewBuilder private var classes: some View {
        let all = setup.classes
        let usual = setup.usual
        if all.isEmpty && usual.isEmpty {
            Hint(L("No classes yet. Import from NUSMods or add them by hand."))
        } else if let campus = setup.campus {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(dayOrder, id: \.self) { day in
                    let rows = all.filter { $0.day == day }.sorted { $0.arriveByMin < $1.arriveByMin }
                    let weekly = usual.filter { $0.day == day }
                    if !rows.isEmpty || !weekly.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text(dayLong(day)).font(.headline).accessibilityAddTraits(.isHeader)
                            ForEach(rows) { c in
                                HStack(alignment: .firstTextBaseline) {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(c.label + weeksText(c.weeks))
                                        Text(c.endMin.map { "\(clockMin(c.arriveByMin))–\(clockMin($0))" } ?? clockMin(c.arriveByMin))
                                            .font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    StopMenu(campus: campus, label: L("Stop for %@", c.label), selection: c.to) { setup.setClassStop(c, to: $0) }
                                    Button(L("Remove")) { setup.removeClass(c) }
                                        .buttonStyle(.link)
                                        .accessibilityLabel(L("Remove %@", c.label))
                                }
                            }
                            ForEach(weekly, id: \.atMin) { u in
                                HStack {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(u.label)
                                        Text("\(clockMin(u.atMin)) · \(campus.stopName(u.to))").font(.caption).foregroundStyle(.secondary)
                                    }
                                    Spacer()
                                    Button(L("Remove")) { setup.removeUsual(place: u.place, day: u.day, atMin: u.atMin) }
                                        .buttonStyle(.link)
                                        .accessibilityLabel(L("Remove %@", u.label))
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    /// " · wk 1–6" for a class that runs only some weeks.
    private func weeksText(_ weeks: [Int]?) -> String {
        guard let w = weeks, w.count < 13, let a = w.first, let b = w.last else { return "" }
        return " · " + L("weeks %@–%@", "\(a)", "\(b)")
    }
}

/// A day, a start and end, a name and where: a class or anything weekly.
private struct AddClassForm: View {
    @Bindable var app: AppModel
    let setup: SetupModel
    let onDone: () -> Void
    @State private var day = 1
    @State private var start = Calendar.current.date(bySettingHour: 9, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var end = Calendar.current.date(bySettingHour: 10, minute: 0, second: 0, of: Date()) ?? Date()
    @State private var hasEnd = false
    @State private var name = ""
    @State private var query = ""
    @State private var picked: Destination?

    private func minutes(_ d: Date) -> Int {
        let c = Calendar.current.dateComponents([.hour, .minute], from: d)
        return (c.hour ?? 0) * 60 + (c.minute ?? 0)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker(L("Day"), selection: $day) {
                ForEach(dayOrder, id: \.self) { Text(dayLong($0)).tag($0) }
            }
            .fixedSize()
            HStack {
                DatePicker(L("Starts"), selection: $start, displayedComponents: .hourAndMinute)
                Toggle(L("Ends"), isOn: $hasEnd)
                if hasEnd { DatePicker(L("Ends"), selection: $end, displayedComponents: .hourAndMinute).labelsHidden() }
            }
            TextField(L("Name"), text: $name, prompt: Text(L("e.g. Gym")))
                .textFieldStyle(.roundedBorder)
            WhereField(app: app, setup: setup, query: $query, picked: $picked)
            HStack {
                Spacer()
                Button(L("Add")) {
                    guard let d = picked else { return }
                    let a = minutes(start), b = minutes(end)
                    setup.addManual(day: day, at: a, end: hasEnd && b > a ? b : nil, to: d.goesTo, label: name.trimmingCharacters(in: .whitespaces))
                    name = ""
                    query = ""
                    picked = nil
                    onDone()
                }
                .disabled(picked == nil || name.trimmingCharacters(in: .whitespaces).isEmpty || (hasEnd && minutes(end) <= minutes(start)))
                .keyboardShortcut(.defaultAction)
            }
        }
    }
}

/// "Where": a stop, building or room, searched for; favourites and where
/// classes are come first before anything is typed.
struct WhereField: View {
    @Bindable var app: AppModel
    let setup: SetupModel
    @Binding var query: String
    @Binding var picked: Destination?

    private var suggestions: [Destination] {
        let favs = setup.places.compactMap { p in app.destinations.first { $0.code == p.to || ($0.kind == "stop" && $0.code == p.to) } }
        let classStops = Array(Set(setup.classes.map(\.to))).compactMap { to in app.destinations.first { $0.kind == "stop" && $0.code == to } }
        var seen = Set<String>()
        return (favs + classStops).filter { seen.insert($0.code).inserted }.prefix(8).map { $0 }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let p = picked {
                HStack {
                    Text(L("Where")).foregroundStyle(.secondary)
                    Text(p.label).fontWeight(.medium)
                    Button(L("Change")) { picked = nil }.buttonStyle(.link)
                }
            } else {
                TextField(L("Where"), text: $query, prompt: Text(L("Stop, building or room")))
                    .textFieldStyle(.roundedBorder)
                    .onAppear { app.loadDestinations() }
                let q = query.trimmingCharacters(in: .whitespaces)
                let list = q.isEmpty ? suggestions : rankDestinations(app.destinations, q)
                ForEach(list, id: \.self) { d in
                    Button {
                        picked = d
                    } label: {
                        DestinationLabel(destination: d)
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 2)
                }
            }
        }
    }
}

/// A search result in Settings: its name, and its code under it when that's different.
struct DestinationLabel: View {
    let destination: Destination

    var body: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(destination.label)
            if destination.label != destination.code { Text(destination.code).font(.caption).foregroundStyle(.secondary) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }
}

/// Your classes (a bus earlier, or no reminders) and the trip history, under Your trips.
struct ChoicesSection: View {
    let setup: SetupModel
    @State private var confirmClear = false

    var body: some View {
        if let r = setup.choices {
            if !r.choices.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("Your classes")).font(.headline).accessibilityAddTraits(.isHeader)
                    GroupBox {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(r.choices, id: \.self) { c in
                                let name = c.label ?? L("A class no longer in your timetable")
                                HStack {
                                    VStack(alignment: .leading, spacing: 1) {
                                        Text(name)
                                        Hint(c.pref == "earlier" ? L("One bus earlier") : L("No reminders"))
                                    }
                                    Spacer()
                                    Button(L("Undo")) { Task { await setup.undoChoice(c) } }
                                        .accessibilityLabel(L("Undo for %@", name))
                                }
                            }
                        }
                        .padding(6)
                    }
                }
            }
            if r.history > 0 {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L("Trip history")).font(.headline).accessibilityAddTraits(.isHeader)
                    GroupBox {
                        HStack {
                            Text(r.history == 1 ? L("1 trip recorded.") : L("%@ trips recorded.", "\(r.history)"))
                            Spacer()
                            Button(L("Clear trip history")) { confirmClear = true }
                        }
                        .padding(6)
                    }
                    Hint(L("Kept for 35 days and used only to spot classes you often miss or skip.")).padding(.leading, 4)
                }
                .confirmationDialog(L("Clear your trip history? Your settings won't change."), isPresented: $confirmClear) {
                    Button(L("Clear trip history"), role: .destructive) { Task { await setup.clearHistory() } }
                }
            }
        }
    }
}

/// What terminus is, that it isn't NUS's, where its data comes from, and links.
struct AboutPane: View {
    private let version = Api.version ?? "dev"
    @State private var developer = Servers.menuShown
    @State private var clicks = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("terminus tells you which NUS shuttle bus to catch, from which stop, and when to leave, from your NUSMods timetable."))
                .fixedSize(horizontal: false, vertical: true)
            Hint(L("terminus is an independent student project, not affiliated with NUS. Bus times come from NUS's shuttle feed. Walking routes and the map use data from OpenStreetMap contributors."))
            Hint(L("Use terminus in line with the NUS Acceptable Use Policy for IT Resources."))
            // Clicked seven times, it shows the developer menu, as Android's build number does.
            Hint(L("Version %@", version))
                .onTapGesture {
                    guard !developer else { return }
                    clicks += 1
                    if clicks >= Servers.unlockClicks {
                        Servers.unlockMenu()
                        developer = true
                    }
                }
            Flow(spacing: 8) {
                link(L("Get the apps"), "\(Api.linkBase)/")
                link(L("Status"), "\(Api.linkBase)/status")
                link(L("Privacy"), "\(Api.linkBase)/privacy")
                link(L("API docs"), "\(Api.linkBase)/docs")
                link(L("Source code"), "https://github.com/rcnsh/terminus")
                link(L("Map data"), "https://www.openstreetmap.org/copyright")
                link(L("NUS Acceptable Use Policy"), "https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf")
            }
            if developer { DeveloperSection() }
        }
    }

    private func link(_ title: String, _ url: String) -> some View {
        Button(title) { NSWorkspace.shared.open(URL(string: url)!) }
    }
}

/// Which server terminus talks to, from the ones built in (Servers). It
/// starts again on the one chosen.
private struct DeveloperSection: View {
    @State private var chosen = Api.base

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider().padding(.vertical, 4)
            Text(L("Developer")).font(.headline)
            Picker(L("Server"), selection: $chosen) {
                ForEach(Array(Servers.choices.enumerated()), id: \.element) { i, base in
                    Text(label(base, first: i == 0)).tag(base)
                }
            }
            .pickerStyle(.radioGroup)
            .onChange(of: chosen) { _, base in Servers.choose(base) }
            Hint(L("Which server this app talks to. Only terminus's own are here. terminus starts again to switch, and the dev stub keeps its own sign-in."))
        }
    }

    private func label(_ base: String, first: Bool) -> String {
        let host = base.replacingOccurrences(of: "https://", with: "").replacingOccurrences(of: "http://", with: "")
        if Servers.isLocal(base) { return L("%@ (dev stub on this Mac)", host) }
        return first ? L("%@ (default)", host) : host
    }
}

/// A note to the operator about anything, written like a message: who it's
/// from, the note, then Send. Only an account with an email can send one, so
/// there's someone to reply to; without one, the pane asks for an email. A
/// wrong answer is better sent from under the card. Under that, a stop
/// suggestion (`StopSuggestion`).
struct FeedbackPane: View {
    let app: AppModel
    let setup: SetupModel
    @State private var note = ""
    @State private var result: String?
    @State private var sent = false
    @State private var sending = false

    private static let limit = 1000
    /// The note's length as the server counts it (JavaScript's, in UTF-16
    /// units), so an emoji counts as two here too and the counter never says
    /// a note fits that the server would refuse.
    static func length(_ s: String) -> Int { s.utf16.count }
    /// At most `limit` of those, never cutting a character in half.
    static func clipped(_ s: String) -> String {
        var out = ""
        for c in s {
            if out.utf16.count + c.utf16.count > limit { break }
            out.append(c)
        }
        return out
    }

    private var canSend: Bool { !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending }

    var body: some View {
        // As the Account pane decides: the flag kept on this Mac, or the account as loaded.
        if app.anonymous || setup.me?.anonymous == true { needsEmail } else { compose }
    }

    private var needsEmail: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(L("Add an email to send feedback")).fontWeight(.semibold)
            Text(L("So we can reply to you. Your setup stays as it is."))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(L("Add an email…")) { app.settingsPane = .account }
                .buttonStyle(.borderedProminent)
                .padding(.top, 4)
        }
        .card(padding: 12)
    }

    private var compose: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                VStack(spacing: 0) {
                    from
                    Divider()
                    editor
                    Divider()
                    footer
                }
                .card(padding: 0)
                if sent { Text(L("Thanks. Your feedback was sent.")).foregroundStyle(.secondary).padding(.horizontal, 4).announced(L("Thanks. Your feedback was sent.")) }
                if let result { Text(result).foregroundStyle(Color.bad).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4).announced(result) }
            }
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "exclamationmark.bubble")
                    .font(.title3)
                    .foregroundStyle(.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("A wrong answer?")).fontWeight(.semibold)
                    Text(L("Choose “Report a wrong answer…” from the menu at the bottom, so we see what you saw."))
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .card(padding: 10)
            .accessibilityElement(children: .combine)
            StopSuggestion(setup: setup)
        }
    }

    /// "From": the account's email.
    private var from: some View {
        HStack(spacing: 8) {
            Text(L("From")).foregroundStyle(.secondary)
            Text(setup.me?.email ?? "").lineLimit(1).truncationMode(.middle)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
    }

    /// The note, the card's body, scrolling inside it.
    private var editor: some View {
        TextEditor(text: $note)
            .font(.body)
            .scrollContentBackground(.hidden)
            .accessibilityLabel(L("Ideas, problems, anything"))
            .overlay(alignment: .topLeading) {
                if note.isEmpty {
                    Text(L("Ideas, problems, anything: a place you want to go, something that confused you…"))
                        .foregroundStyle(.secondary)
                        .padding(.leading, 5)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .frame(height: 140)
            .padding(.horizontal, 7)
            .padding(.vertical, 8)
            .onChange(of: note) { _, v in if Self.length(v) > Self.limit { note = Self.clipped(v) } }
    }

    private var footer: some View {
        HStack {
            Text(verbatim: "\(Self.length(note)) / \(Self.limit)")
                .font(.caption.monospacedDigit())
                .foregroundStyle(Self.length(note) >= 900 ? Color.warn : Color.secondary)
                .accessibilityLabel(L("%@ of %@ characters", "\(Self.length(note))", "\(Self.limit)"))
            Spacer()
            Button(L("Send")) {
                sending = true
                Task {
                    result = await setup.sendFeedback(note)
                    sent = result == nil
                    if sent { note = "" }
                    sending = false
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSend)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

/// "A better stop for a building": the building, the stop you use for it and
/// why, sent as a stop suggestion. The map's nearest stop is sometimes the
/// one nobody uses (a climb, no crossing); only someone who walks it knows.
struct StopSuggestion: View {
    let setup: SetupModel
    @State private var building = ""
    @State private var stop = ""
    @State private var why = ""
    @State private var result: String?
    @State private var sent = false
    @State private var sending = false

    private var canSend: Bool { !building.trimmingCharacters(in: .whitespaces).isEmpty && !stop.isEmpty && !sending }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L("A better stop for a building")).font(.headline).padding(.horizontal, 4).accessibilityAddTraits(.isHeader)
            VStack(alignment: .leading, spacing: 10) {
                LabeledContent(L("Building")) {
                    TextField(L("Building"), text: $building, prompt: Text(verbatim: "LT21"))
                        .labelsHidden()
                        .frame(maxWidth: 220)
                }
                LabeledContent(L("The stop you use")) {
                    if let campus = setup.campus {
                        StopMenu(campus: campus, label: L("The stop you use"), selection: stop, blank: L("Choose a stop")) { stop = $0 }
                    } else {
                        ProgressView().controlSize(.small)
                    }
                }
                LabeledContent(L("Why (optional)")) {
                    TextField(L("Why (optional)"), text: $why, prompt: Text(L("A path leads straight there")))
                        .labelsHidden()
                        .frame(maxWidth: 220)
                }
                HStack {
                    Spacer()
                    Button(L("Suggest this stop")) {
                        sending = true
                        result = nil
                        Task {
                            result = await setup.suggestStop(building, stop: stop, why: why)
                            sent = result == nil
                            if sent { building = ""; stop = ""; why = "" }
                            sending = false
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(!canSend)
                }
            }
            .card(padding: 12)
            .onChange(of: building) { _, _ in result = nil; sent = false }
            .onChange(of: stop) { _, _ in result = nil; if !stop.isEmpty { sent = false } }
            Text(L("If we send you to a stop you never use for a building, tell us the one you do."))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
            if sent { Text(L("Thanks. We’ll walk it and change the stop if it’s better.")).foregroundStyle(.secondary).padding(.horizontal, 4).announced(L("Thanks. We’ll walk it and change the stop if it’s better.")) }
            if let result { Text(result).foregroundStyle(Color.bad).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4).announced(result) }
        }
    }
}

/// Adding an email to an account that has none: the same email sign-in as
/// the first screen, keeping this Mac's setup (or, when both have one, asking).
struct AddEmail: View {
    @Bindable var app: AppModel
    @State private var email = ""
    @State private var code = ""

    private var emailOK: Bool { looksLikeEmail(email) }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let c = app.chooseSetup {
                Text(L("%@ already has a setup. Which do you want to keep?", c.email)).fixedSize(horizontal: false, vertical: true)
                HStack {
                    Button(L("Keep the account's")) { app.keepSetup(mac: false) }
                    Button(L("Keep this Mac's")) { app.keepSetup(mac: true) }
                }
            } else if let w = app.signInWaiting {
                Text(L("Sent to %@. Not there after a minute? Check your spam folder. The code works for 15 minutes.", w.email))
                    .fixedSize(horizontal: false, vertical: true)
                CodeField(code: $code, label: L("Code from the email"), onEdit: { app.signInError = nil }) { app.enterCode($0) }
                    .padding(.vertical, 4)
                Hint(L("Or open the link in the email and choose %@.", "\(w.match)"))
                Button(L("Use a different email")) {
                    code = ""
                    app.cancelSignIn()
                }
            } else {
                Text(L("Add an email to use terminus on your other devices too, and to keep your setup if this Mac is lost."))
                    .fixedSize(horizontal: false, vertical: true)
                HStack {
                    TextField(L("Email"), text: $email, prompt: Text(verbatim: "you@u.nus.edu")).textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                    Button(app.signingIn ? L("Sending…") : L("Email me a code")) { app.signIn(email: email.trimmingCharacters(in: .whitespaces)) }
                        .disabled(!emailOK || app.signingIn)
                }
            }
            if let e = app.signInError { Text(e).foregroundStyle(Color.bad).fixedSize(horizontal: false, vertical: true).announced(e) }
        }
    }
}
