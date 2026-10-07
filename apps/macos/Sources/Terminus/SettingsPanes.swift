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
func dayShort(_ day: Int) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.locale = Lang.locale
    return cal.shortWeekdaySymbols[((day % 7) + 7) % 7]
}

func dayLong(_ day: Int) -> String {
    var cal = Calendar(identifier: .gregorian)
    cal.locale = Lang.locale
    return cal.weekdaySymbols[((day % 7) + 7) % 7]
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
            DisclosureGroup(L("Import from NUSMods"), isExpanded: $importOpen) {
                VStack(alignment: .leading, spacing: 6) {
                    TextField("https://nusmods.com/timetable/sem-1/share?…", text: $link)
                        .textFieldStyle(.roundedBorder)
                        .onSubmit { Task { await setup.importTimetable(link) } }
                    HStack {
                        Button(setup.importing ? L("Importing…") : L("Import")) { Task { await setup.importTimetable(link) } }
                            .disabled(link.trimmingCharacters(in: .whitespaces).isEmpty || setup.importing)
                        Hint(L("In NUSMods: Timetable → Share/Sync → Copy. Re-import each semester."))
                    }
                    if let r = setup.imported {
                        Text(r.classes == 1 ? L("Imported 1 class for %@.", r.term) : L("Imported %@ classes for %@.", "\(r.classes)", r.term))
                        if !r.missing.isEmpty { Hint(L("NUSMods has no classes this semester for %@.", r.missing.joined(separator: ", "))) }
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
                            Text(dayLong(day)).font(.headline)
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
                                    Button(L("Remove")) { setup.removeUsual(place: u.place, day: u.day, atMin: u.atMin) }.buttonStyle(.link)
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
        return " · " + L("wk %@–%@", "\(a)", "\(b)")
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
                    setup.addManual(day: day, at: a, end: hasEnd && b > a ? b : nil, to: d.kind == "landmark" ? d.code : d.stopCode, label: name.trimmingCharacters(in: .whitespaces))
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
                        VStack(alignment: .leading, spacing: 1) {
                            Text(d.label)
                            if d.label != d.code { Text(d.code).font(.caption).foregroundStyle(.secondary) }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, 2)
                }
            }
        }
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
                    Text(L("Your classes")).font(.headline)
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
                    Text(L("Trip history")).font(.headline)
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
    private let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L("terminus tells you which NUS shuttle bus to catch, from which stop, and when to leave, from your NUSMods timetable."))
                .fixedSize(horizontal: false, vertical: true)
            Hint(L("terminus is an independent student project, not affiliated with NUS. Bus times come from NUS's shuttle feed. Walking routes and the map use data from OpenStreetMap contributors."))
            Hint(L("Use terminus in line with the NUS Acceptable Use Policy for IT Resources."))
            Hint(L("Version %@", version))
            Flow(spacing: 8) {
                link(L("Get the apps"), "\(Api.site)/")
                link(L("Status"), "\(Api.site)/status")
                link(L("Privacy"), "\(Api.site)/privacy")
                link(L("API docs"), "\(Api.site)/docs")
                link(L("Source code"), "https://github.com/rcnsh/terminus")
                link(L("Map data"), "https://www.openstreetmap.org/copyright")
                link(L("NUS Acceptable Use Policy"), "https://nus.edu.sg/registrar/docs/info/registration-guides/aup-form.pdf")
            }
        }
    }

    private func link(_ title: String, _ url: String) -> some View {
        Button(title) { NSWorkspace.shared.open(URL(string: url)!) }
    }
}

/// A note to the operator about anything, written like a message: who it's
/// from, the note, then Send. An account with no email can give one to reply
/// to, for this note only; a wrong answer is better sent from under the card.
struct FeedbackPane: View {
    let setup: SetupModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var note = ""
    @State private var replyTo = ""
    @State private var addingEmail = false
    @FocusState private var emailFocused: Bool
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

    private var reply: String { replyTo.trimmingCharacters(in: .whitespaces) }
    /// Typed, but not local@domain.tld.
    private var replyBad: Bool { addingEmail && !reply.isEmpty && reply.range(of: #"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"#, options: .regularExpression) == nil }
    private var canSend: Bool { !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending && !replyBad }

    var body: some View {
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
                if addingEmail {
                    Hint(L("We’ll only use this to reply. It isn’t added to your account."))
                        .padding(.horizontal, 4)
                        .transition(.opacity.combined(with: .move(edge: .top)))
                }
                if sent { Text(L("Thanks. Your feedback was sent.")).foregroundStyle(.secondary).padding(.horizontal, 4) }
                if let result { Text(result).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4) }
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
        }
    }

    private var animation: Animation { reduceMotion ? .easeInOut(duration: 0.15) : .spring(response: 0.3, dampingFraction: 0.85) }

    /// "From": the account's email, or Anonymous with a way to give one for this note.
    private var from: some View {
        HStack(spacing: 8) {
            Text(L("From")).foregroundStyle(.secondary)
            if let email = setup.me?.email {
                Text(email).lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
            } else {
                ZStack(alignment: .leading) {
                    if addingEmail {
                        TextField(L("Email to reply to"), text: $replyTo, prompt: Text(L("Email to reply to")))
                            .textFieldStyle(.plain)
                            .textContentType(.emailAddress)
                            .foregroundStyle(replyBad ? Color.red.opacity(0.85) : Color.primary)
                            .focused($emailFocused)
                            .onAppear { DispatchQueue.main.async { emailFocused = true } }
                            .transition(.opacity.combined(with: .offset(y: 6)))
                    } else {
                        Text(L("Anonymous · no reply"))
                            .foregroundStyle(.secondary)
                            .transition(.opacity.combined(with: .offset(y: -6)))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    withAnimation(animation) {
                        if addingEmail { replyTo = "" }
                        addingEmail.toggle()
                    }
                } label: {
                    // Both words laid out, one shown: the button keeps its width as they crossfade.
                    ZStack(alignment: .trailing) {
                        Text(L("Add an email")).opacity(addingEmail ? 0 : 1)
                        Text(L("Cancel")).opacity(addingEmail ? 1 : 0)
                    }
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(addingEmail ? L("Cancel") : L("Add an email"))
            }
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
        .background(replyBad ? Color.red.opacity(0.06) : Color.clear)
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
                        .foregroundStyle(.tertiary)
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
                .foregroundStyle(Self.length(note) >= 900 ? Color.orange : Color.secondary)
                .accessibilityLabel(L("%@ of %@ characters", "\(Self.length(note))", "\(Self.limit)"))
            Spacer()
            Button(L("Send")) {
                sending = true
                let to = addingEmail && !reply.isEmpty ? reply : nil
                Task {
                    result = await setup.sendFeedback(note, replyTo: to)
                    sent = result == nil
                    // The address stays, for the next note.
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

/// Adding an email to an account that has none: the same email sign-in as
/// the first screen, keeping this Mac's setup (or, when both have one, asking).
struct AddEmail: View {
    @Bindable var app: AppModel
    @State private var email = ""
    @State private var code = ""

    private var emailOK: Bool { email.trimmingCharacters(in: .whitespaces).range(of: #"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"#, options: .regularExpression) != nil }

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
                    TextField("you@u.nus.edu", text: $email).textFieldStyle(.roundedBorder).frame(maxWidth: 260)
                    Button(app.signingIn ? L("Sending…") : L("Email me a code")) { app.signIn(email: email.trimmingCharacters(in: .whitespaces)) }
                        .disabled(!emailOK || app.signingIn)
                }
            }
            if let e = app.signInError { Text(e).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true) }
        }
    }
}
