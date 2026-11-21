import SwiftUI

struct ReportSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Binding var addEmail: Bool
    @State private var reason: String?
    @State private var note = ""
    @State private var raw: Data?
    @State private var line = ""
    @State private var fromNus = false
    @State private var fits: [String]?
    @FocusState private var noteFocused: Bool
    @Environment(\.windowWidth) private var width
    @ScaledMetric(relativeTo: .body) private var threeLines: CGFloat = 66

    init(addEmail: Binding<Bool>) {
        _addEmail = addEmail
        let a = AppModel.shared.answer
        _raw = State(initialValue: a?.raw)
        _line = State(initialValue: a?.card?.line ?? a?.label ?? "")
        _fromNus = State(initialValue: a?.card?.fromNus ?? false)
        _fits = State(initialValue: a?.card?.reasons)
    }

    nonisolated static let allReasons = ["never-came", "times-off", "wrong-stop", "walk-longer", "wrong-class"]

    nonisolated static func reasons(fitting fits: [String]?) -> [String] {
        guard let fits else { return allReasons }
        return allReasons.filter(fits.contains)
    }

    private var reasons: [(String, String)] { Self.reasons(fitting: fits).map { ($0, Self.label($0)) } }

    private static func label(_ reason: String) -> String {
        switch reason {
        case "never-came": L("Bus never came")
        case "times-off": L("Times were off")
        case "wrong-stop": L("Wrong stop")
        case "walk-longer": L("Walk is longer")
        default: L("Wrong class")
        }
    }

    private static let nusReasons: Set<String> = ["never-came", "times-off"]
    private var aboutNus: Bool { fromNus && (reason.map(Self.nusReasons.contains) ?? false) }

    var body: some View {
        Group {
            if width == .narrow {
                NavigationStack {
                    ScrollView { page }
                        .scrollDismissesKeyboard(.interactively)
                        .background(Color.page)
                        .toolbar {
                            ToolbarItem(placement: .cancellationAction) {
                                if !app.reportSent { Button(L("Cancel")) { dismiss() } }
                            }
                        }
                }
            } else {
                VStack(alignment: .leading, spacing: 0) {
                    if !app.reportSent {
                        Button(L("Cancel")) { dismiss() }
                            .buttonStyle(ChipButtonStyle())
                            .padding([.horizontal, .top], 16)
                    }
                    SheetScroll { page }.scrollDismissesKeyboard(.interactively)
                }
                .background(Color.page)
            }
        }
        .presentationDetents([.large])
        .centredSheet(fits: true)
        .onAppear {
            let a = app.answer
            raw = a?.raw
            line = a?.card?.line ?? a?.label ?? ""
            fromNus = a?.card?.fromNus ?? false
        }
    }

    private var page: some View {
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
                addEmail = true
                dismiss()
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
                        Text(label)
                    }
                    .buttonStyle(ChipButtonStyle(filled: on))
                    .accessibilityAddTraits(on ? .isSelected : [])
                    .accessibilityIdentifier("reason.\(key)")
                }
            }
            if aboutNus {
                VStack(alignment: .leading, spacing: 4) {
                    Text(L("Bus times come from NUS")).font(.subheadline.weight(.semibold))
                    Text(
                        L(
                            "terminus shows the times NUS's shuttle system gives it. When a bus doesn't come or its time is off, that's usually on NUS's side, and we can't fix it from here."
                        )
                    )
                    .font(.subheadline)
                    .foregroundStyle(Color.muted)
                }
                .fixedSize(horizontal: false, vertical: true)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.brandSoft, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .accessibilityElement(children: .combine)
                .announced(L("Bus times come from NUS"))
                .padding(.top, 12)
                .accessibilityIdentifier("report.nus")
            }
            TextField(text: $note, prompt: Text(L("What happened? A time or a stop helps.")), axis: .vertical) { Text(L("Your note")) }
                .lineLimit(3...6)
                .frame(minHeight: width == .narrow ? nil : threeLines, alignment: .topLeading)
                .focused($noteFocused)
                .padding(12)
                .background(Color.surface2, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.top, 12)
                .onChange(of: note) { _, n in if n.utf16.count > 1000 { note = clippedUTF16(n, 1000) } }
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
            Button(app.reportSending ? L("Sending…") : aboutNus ? L("Send anyway") : L("Send")) {
                noteFocused = false
                app.report(reason: reason, note: note, answer: raw)
            }
            .buttonStyle(.primary)
            .disabled(app.reportSending || (reason == nil && note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
            .padding(.top, 16)
            .accessibilityIdentifier("report.send")
        }
    }

    private func withEmail(_ text: String, _ email: String) -> AttributedString {
        var s = AttributedString(text)
        if let r = s.range(of: email) {
            s[r].foregroundColor = .ink
            s[r].font = .footnote.weight(.semibold)
        }
        return s
    }
}

struct GoLaterSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var time = soonOnCampus()
    @State private var failure: String?
    @State private var saving = false

    @Environment(\.windowWidth) private var width

    var body: some View {
        Group {
            if width == .narrow {
                NavigationStack {
                    VStack(spacing: 0) {
                        picker
                        Spacer()
                    }
                    .padding(.horizontal, 20)
                    .navigationTitle(L("Go later today at…"))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) { Button(L("Cancel")) { dismiss() } }
                        ToolbarItem(placement: .confirmationAction) { ok }
                    }
                }
            } else {
                VStack(spacing: 12) {
                    HStack {
                        Button(L("Cancel")) { dismiss() }.buttonStyle(ChipButtonStyle())
                        Spacer()
                        ok.buttonStyle(ChipButtonStyle(filled: true))
                    }
                    .overlay { Text(L("Go later today at…")).font(.headline).accessibilityAddTraits(.isHeader) }
                    picker
                }
                .padding(16)
                .background(Color.page)
            }
        }
        .presentationDetents(width == .narrow ? [.medium] : [.large])
        .centredSheet(fits: true)
    }

    @ViewBuilder private var picker: some View {
        DatePicker(L("Time"), selection: $time, displayedComponents: .hourAndMinute)
            .datePickerStyle(.wheel)
            .labelsHidden()
            .frame(height: width == .narrow ? nil : 216)
            .environment(\.timeZone, .campus)
            .environment(
                \.locale,
                Clock.hour12
                    ? Locale(identifier: Lang.zh ? "zh_Hans_SG" : "en_SG") : Locale(identifier: Lang.zh ? "zh_Hans_CN" : "en_GB"))
        if let failure { Text(failure).font(.footnote).foregroundStyle(Color.bad).padding(.top, 8) }
    }

    private var ok: some View {
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

func soonOnCampus(_ now: Date = ServerClock.now) -> Date {
    var cal = Calendar(identifier: .gregorian)
    cal.timeZone = .campus
    let c = cal.dateComponents([.hour, .minute], from: now)
    let m = min(23 * 60 + 55, ((c.hour ?? 0) * 60 + (c.minute ?? 0) + 30 + 4) / 5 * 5)
    return cal.date(bySettingHour: m / 60, minute: m % 60, second: 0, of: now) ?? now
}
