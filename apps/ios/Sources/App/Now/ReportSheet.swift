import SwiftUI

/// "Is this wrong?": the answer it's about, the reasons as chips, a note,
/// and who the reply goes to. A reason or a note sends it; once sent, the
/// sheet says so, which is the only confirmation. Without an email the
/// server takes no reports, so it asks for one instead. As the web's sheet.
struct ReportSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var reason: String?
    @State private var note = ""
    /// The answer as it was when the sheet opened: what the report is about, whatever refreshes meanwhile.
    @State private var raw: Data?
    @State private var line = ""
    @FocusState private var noteFocused: Bool

    /// The reasons, as /me/feedback takes them (REASONS in the API's feedback.ts).
    private var reasons: [(String, String)] {
        [
            ("never-came", L("Bus never came")), ("times-off", L("Times were off")), ("wrong-stop", L("Wrong stop")),
            ("walk-longer", L("Walk is longer")), ("wrong-class", L("Wrong class")),
        ]
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if app.reportSent {
                        sent
                    } else if let email = app.email {
                        form(email)
                    } else {
                        needsEmail
                    }
                }
                .padding(20)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Color.page)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    if !app.reportSent { Button(L("Cancel")) { dismiss() } }
                }
            }
        }
        .presentationDetents([.large])
        .onAppear {
            let a = app.answer
            raw = a?.raw
            line = a?.card?.line ?? a?.label ?? ""
        }
    }

    private var sent: some View {
        VStack(spacing: 0) {
            Image(systemName: "checkmark")
                .font(.system(size: 28, weight: .bold))
                .foregroundStyle(Color.good)
                .frame(width: 56, height: 56)
                .background(Color.good.opacity(0.18), in: Circle())
                .padding(.top, 24)
            Text(L("Thanks, it's sent"))
                .font(.title2.weight(.bold))
                .padding(.top, 14)
                .announced(L("Thanks, it's sent"))
            if let email = app.email {
                Text(withEmail(L("We'll look at this answer, and reply to %@ if we need to know more.", email), email))
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                    .multilineTextAlignment(.center)
                    .padding(.top, 6)
            }
            Button(L("Done")) { dismiss() }
                .buttonStyle(.primary)
                .padding(.top, 24)
                .accessibilityIdentifier("report.done")
        }
        .frame(maxWidth: .infinity)
    }

    private var needsEmail: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(L("What was wrong?")).font(.title2.weight(.bold))
            Text(L("Add your email to report a wrong answer, so we can reply to you."))
                .foregroundStyle(Color.muted)
                .padding(.top, 10)
            Button(L("Add your email")) {
                dismiss()
                // A flag rather than a notification: Settings may not have been built yet.
                app.wantsSignIn = true
                NotificationCenter.default.post(name: .openTab, object: MainTabs.Tab.settings)
            }
            .buttonStyle(.primary)
            .padding(.top, 20)
            .accessibilityIdentifier("report.addEmail")
        }
    }

    private func form(_ email: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(L("What was wrong?")).font(.title2.weight(.bold))
            if !line.isEmpty {
                HStack(spacing: 10) {
                    RoundedRectangle(cornerRadius: 2).fill(Color.brand).frame(width: 4)
                    Text(line).font(.subheadline.weight(.semibold))
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.top, 14)
            }
            Text(L("Pick one, or say what happened")).font(.footnote).foregroundStyle(Color.muted).padding(.top, 16).padding(.bottom, 8)
            FlowLayout(spacing: 8) {
                ForEach(reasons, id: \.0) { key, label in
                    let on = reason == key
                    Button {
                        reason = on ? nil : key
                    } label: {
                        HStack(spacing: 6) {
                            if on { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)) }
                            Text(label)
                        }
                    }
                    .buttonStyle(ChipButtonStyle(filled: on))
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("reason.\(key)")
                }
            }
            TextField(text: $note, prompt: Text(L("What happened? A time or a stop helps.")), axis: .vertical) { Text(L("Your note")) }
                .lineLimit(3...6)
                .focused($noteFocused)
                .padding(12)
                .background(Color.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.top, 12)
                .onChange(of: note) { _, n in if n.count > 1000 { note = String(n.prefix(1000)) } }
                .accessibilityIdentifier("report.note")
            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "envelope").foregroundStyle(Color.muted)
                Text(withEmail(L("We'll reply to %@. This answer is sent with your report.", email), email))
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
            }
            .padding(.top, 12)
            if let failure = app.reportResult {
                Text(failure).font(.footnote).foregroundStyle(Color.bad).padding(.top, 8).announced(failure)
            }
            Button(app.reportSending ? L("Sending…") : L("Send")) {
                noteFocused = false
                app.report(reason: reason, note: note, answer: raw)
            }
            .buttonStyle(.primary)
            .disabled(app.reportSending || (reason == nil && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            .padding(.top, 16)
            .accessibilityIdentifier("report.send")
        }
    }

    /// `text` with the email address in it picked out.
    private func withEmail(_ text: String, _ email: String) -> AttributedString {
        var s = AttributedString(text)
        if let r = s.range(of: email) {
            s[r].foregroundColor = .ink
            s[r].font = .footnote.weight(.semibold)
        }
        return s
    }
}

/// "Go later today at…": a one-off trip to the place on screen, planned like a class.
struct GoLaterSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var time = soonOnCampus()
    @State private var failure: String?
    @State private var saving = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                DatePicker(L("Time"), selection: $time, displayedComponents: .hourAndMinute)
                    .datePickerStyle(.wheel)
                    .labelsHidden()
                    .environment(\.timeZone, .campus)
                    .environment(
                        \.locale,
                        Clock.hour12
                            ? Locale(identifier: Lang.zh ? "zh_Hans_SG" : "en_SG") : Locale(identifier: Lang.zh ? "zh_Hans_CN" : "en_GB"))
                if let failure { Text(failure).font(.footnote).foregroundStyle(Color.bad).padding(.top, 8) }
                Spacer()
            }
            .padding(.horizontal, 20)
            .navigationTitle(L("Go later today at…"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("OK")) {
                        var cal = Calendar(identifier: .gregorian)
                        cal.timeZone = .campus
                        let c = cal.dateComponents([.hour, .minute], from: time)
                        saving = true
                        Task {
                            failure = await app.goLater(atMin: (c.hour ?? 0) * 60 + (c.minute ?? 0))
                            saving = false
                            if failure == nil { dismiss() }
                        }
                    }
                    .disabled(saving)
                    .accessibilityIdentifier("goLater.ok")
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// Half an hour from now on campus, to the next five minutes: where "Go later" starts.
/// By the server's clock, which judges whether the time has passed, not this phone's.
func soonOnCampus(_ now: Date = ServerClock.now) -> Date {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .campus
    let c = cal.dateComponents([.hour, .minute], from: now)
    let m = min(23 * 60 + 55, ((c.hour ?? 0) * 60 + (c.minute ?? 0) + 30 + 4) / 5 * 5)
    return cal.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: now) ?? now
}
