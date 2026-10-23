import CoreImage.CIFilterBuiltins
import SwiftUI
import UniformTypeIdentifiers

/// "Add your email": the email sign-in, which keeps this phone's setup. The
/// welcome flow owns that screen; it answers this notification.
@MainActor func settingsAddEmail() {
    NotificationCenter.default.post(name: .settingsSignIn, object: nil)
}

/// Settings › Devices: each device on the account, removable (this phone
/// signs out), then Add a device, which shows a pairing code and its QR.
/// An account without an email has no other devices, so it asks for one.
struct SettingsDevicesPane: View {
    let model: SettingsModel
    @Environment(AppModel.self) private var app
    @State private var removing: Device?

    var body: some View {
        if app.email == nil {
            SettingsGroup(
                title: L("Not signed in"),
                hint: L(
                    "Your settings are stored only on this phone. Add an email to keep them if you lose your phone, and to use terminus on your Mac or the web."
                )
            ) {
                Button(L("Add your email"), action: settingsAddEmail)
                    .buttonStyle(SettingsInkButtonStyle(full: true))
                    .padding(16)
                    .accessibilityIdentifier("settings.addEmail")
            }
        } else {
            if let devices = model.devices {
                if !devices.isEmpty {
                    SettingsGroup(title: L("Your devices")) {
                        ForEach(Array(devices.enumerated()), id: \.element.id) { i, d in
                            if i > 0 { GroupDivider() }
                            row(d)
                        }
                    }
                }
            } else {
                ProgressView().frame(maxWidth: .infinity).padding(20)
            }
            VStack(alignment: .leading, spacing: 8) {
                Button(L("Add a device")) { model.newPairCode() }
                    .buttonStyle(SettingsInkButtonStyle(full: true))
                    .disabled(model.busy)
                    .accessibilityIdentifier("settings.addDevice")
                SettingsHint(L("Your Mac or another phone. You'll get an email whenever a device is added or removed.")).padding(
                    .horizontal, 4)
            }
            .sheet(isPresented: Binding(get: { model.pairCode != nil }, set: { if !$0 { model.closePairCode() } })) {
                if let code = model.pairCode { SettingsPairCodeSheet(code: code) { model.closePairCode() } }
            }
            .alert(
                removing.map { L("Remove %@?", $0.name ?? settingsPlatformName($0.platform) ?? L("this device")) } ?? "",
                isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing
            ) { d in
                Button(L("Remove"), role: .destructive) { model.removeDevice(d) }
                Button(L("Cancel"), role: .cancel) {}
            } message: { d in
                Text(
                    d.current == true
                        ? L("This phone will be signed out.") : L("It will be signed out, and you'll receive an email confirming this."))
            }
        }
    }

    private func row(_ d: Device) -> some View {
        let name = d.name ?? settingsPlatformName(d.platform) ?? L("A device")
        return HStack(spacing: 12) {
            Image(systemName: icon(d.platform))
                .font(.title3)
                .foregroundStyle(Color.muted)
                .frame(width: 28)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(name).fontWeight(.medium).foregroundStyle(Color.ink).lineLimit(1)
                    if d.current == true {
                        Text(L("This phone"))
                            .font(.caption2.weight(.semibold))
                            .foregroundStyle(Color.muted)
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Color.surface2, in: RoundedRectangle(cornerRadius: 6))
                    }
                }
                SettingsHint([settingsPlatformName(d.platform), used(d)].compactMap { $0 }.joined(separator: " · "))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            QuietRemove(says: L("Remove %@", name)) { removing = d }
        }
        .padding(.leading, 16)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .accessibilityElement(children: .contain)
    }

    private func used(_ d: Device) -> String? {
        guard let ms = d.lastSeen else { return nil }
        let at = Date(timeIntervalSince1970: ms / 1000)
        if -at.timeIntervalSinceNow < 60 { return L("used %@", L("just now")) }
        return L("used %@", at.formatted(.relative(presentation: .named).locale(Lang.locale)))
    }

    private func icon(_ p: String?) -> String {
        switch p {
        case "mac": "laptopcomputer"
        case "web": "globe"
        default: "iphone"
        }
    }
}

func settingsPlatformName(_ p: String?) -> String? {
    switch p {
    case "android": "Android"
    case "mac": "Mac"
    case "ios": "iPhone"
    default: nil
    }
}

/// The code to type on a Mac, and a QR code another phone's camera opens,
/// with Share to send the link. Black on white whatever the theme: cameras read it best.
struct SettingsPairCodeSheet: View {
    let code: String
    let onDone: () -> Void

    private var link: String { "\(Api.linkBase)/pair?code=\(code)" }
    private var spaced: String { "\(code.prefix(3)) \(code.dropFirst(3))" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    Text(L("On your Mac, open terminus and enter:")).foregroundStyle(Color.ink).multilineTextAlignment(.center)
                    Text(verbatim: spaced)
                        .font(.system(size: 38, weight: .bold, design: .monospaced))
                        .tracking(4)
                        .foregroundStyle(Color.ink)
                        .textSelection(.enabled)
                        .accessibilityLabel(code.map(String.init).joined(separator: " "))
                        .accessibilityIdentifier("settings.pairCode")
                    Text(L("Or scan this with another phone's camera:")).foregroundStyle(Color.ink).multilineTextAlignment(.center).padding(
                        .top, 6)
                    if let qr = pairingQR(link) {
                        Image(uiImage: qr)
                            .interpolation(.none)
                            .resizable()
                            .frame(width: 210, height: 210)
                            .padding(12)
                            .background(Color.white, in: RoundedRectangle(cornerRadius: 16))
                            .accessibilityLabel(L("QR code for pairing code %@", code))
                    }
                    SettingsHint(L("Works once, for 10 minutes."))
                    ShareLink(item: URL(string: link)!, message: Text(L("Pair terminus with this link, or enter code %@: %@", code, link)))
                    {
                        Label(L("Send the pairing code"), systemImage: "square.and.arrow.up")
                    }
                    .buttonStyle(SecondaryButtonStyle(full: false))
                    .padding(.top, 4)
                }
                .padding(24)
                .frame(maxWidth: .infinity)
            }
            .background(Color.page)
            .navigationTitle(L("Add a device"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button(L("Done"), action: onDone).accessibilityIdentifier("settings.pairDone")
                }
            }
        }
        .presentationDetents([.large])
    }
}

/// `text` as a QR code, one pixel a module (scaled up without smoothing), with
/// the standard quiet zone of four modules: Core Image's own one, and three more.
func pairingQR(_ text: String) -> UIImage? {
    let f = CIFilter.qrCodeGenerator()
    f.message = Data(text.utf8)
    f.correctionLevel = "M"
    guard let out = f.outputImage else { return nil }
    let padded = out.transformed(by: CGAffineTransform(translationX: 3, y: 3))
        .composited(over: CIImage(color: .white).cropped(to: out.extent.insetBy(dx: -3, dy: -3).offsetBy(dx: 3, dy: 3)))
    let ctx = CIContext()
    guard
        let cg = ctx.createCGImage(
            padded.transformed(by: CGAffineTransform(scaleX: 8, y: 8)), from: padded.extent.applying(CGAffineTransform(scaleX: 8, y: 8)))
    else { return nil }
    return UIImage(cgImage: cg)
}

/// Settings › Account: who you're signed in as, with Sign out; your data; the
/// account page for API keys and signing out everywhere (the web's alone);
/// then Delete this account on its own at the foot, the only red anywhere.
struct SettingsAccountPane: View {
    let model: SettingsModel
    @Environment(AppModel.self) private var app
    @State private var confirmSignOut = false
    @State private var confirmDelete = false
    @State private var exporting = false
    @State private var export: SettingsExportDocument?
    @AppStorage(CrashReporter.key) private var sendCrashReports = true

    var body: some View {
        if let email = app.email {
            SettingsGroup(title: L("Signed in")) {
                HStack(spacing: 12) {
                    AccountInitial(email: email, size: 40)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(email).fontWeight(.medium).foregroundStyle(Color.ink).lineLimit(1).truncationMode(.middle)
                        if let d = model.devices { SettingsHint(settingsDeviceCount(d.count)) }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    Button(L("Sign out")) { confirmSignOut = true }
                        .buttonStyle(ChipButtonStyle())
                        .accessibilityIdentifier("settings.signOut")
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
            }
        } else {
            SettingsGroup(
                title: L("Not signed in"),
                hint: L(
                    "Your settings are stored only on this phone. Add an email to keep them if you lose your phone, and to use terminus on your Mac or the web."
                )
            ) {
                Button(L("Add your email"), action: settingsAddEmail)
                    .buttonStyle(SettingsInkButtonStyle(full: true))
                    .padding(16)
                    .accessibilityIdentifier("settings.addEmail")
            }
        }
        SettingsGroup(title: L("Your data")) {
            SettingLink(title: exporting ? L("Preparing your data…") : L("Download my data"), id: "settings.export") {
                guard !exporting else { return }
                exporting = true
                Task {
                    if let data = await model.export() { export = SettingsExportDocument(data: data) }
                    exporting = false
                }
            }
            if app.email != nil {
                GroupDivider()
                SettingLink(title: L("Account page"), sub: L("API keys, and signing out everywhere"), away: true) {
                    openInSafari("\(Api.linkBase)/account")
                }
            }
            GroupDivider()
            // Kept on this phone, not in the account: it's about this app's crashes.
            SettingSwitch(
                label: L("Send crash reports"),
                sub: L("When terminus crashes, send what broke and the app version. Never who you are or where."), isOn: $sendCrashReports,
                id: "settings.crashReports")
        }
        // An account with an email is deleted from the account page, signed in on the web (the server insists).
        SettingsGroup {
            if app.email == nil {
                SettingLink(title: L("Delete this account"), color: .bad, id: "settings.delete") { confirmDelete = true }
            } else {
                SettingLink(title: L("Delete this account"), away: true, color: .bad, id: "settings.delete") {
                    openInSafari("\(Api.linkBase)/account/#account")
                }
            }
        }
        .alert(L("Sign out of this phone?"), isPresented: $confirmSignOut) {
            Button(L("Sign out"), role: .destructive) { model.signOut() }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(
                L(
                    "The app and widget will stop showing your timetable. Your account and settings are kept; sign in again with %@.",
                    app.email ?? ""))
        }
        .alert(L("Delete this account?"), isPresented: $confirmDelete) {
            Button(L("Delete"), role: .destructive) { model.deleteAccount() }
            Button(L("Cancel"), role: .cancel) {}
        } message: {
            Text(
                L(
                    "Your timetable and settings will be deleted immediately and the app will reset. Without an email on the account, they can't be recovered."
                ))
        }
        .fileExporter(
            isPresented: Binding(get: { export != nil }, set: { if !$0 { export = nil } }), document: export, contentType: .json,
            defaultFilename: "terminus-export.json"
        ) { result in
            if case .success = result { model.say(L("Your data was saved.")) }
            export = nil
        }
    }
}

/// The export, as a file the system's Save sheet writes where the person picks.
struct SettingsExportDocument: FileDocument {
    static let readableContentTypes: [UTType] = [.json]
    let data: Data
    init(data: Data) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}

/// Settings › Send feedback: a note to the operator about anything, laid out
/// as a message: who it's from, the note, a counter and Send. Only an account
/// with an email can send one, so there's someone to reply to.
struct SettingsFeedbackPane: View {
    let model: SettingsModel
    @Environment(AppModel.self) private var app
    @State private var note = ""
    @State private var sending = false
    @State private var result: String?
    @State private var sent = false
    @FocusState private var focused: Bool

    static let limit = 1000
    static let near = 900
    /// The note's length as the server counts it (JavaScript's, in UTF-16 units).
    static func length(_ s: String) -> Int { s.utf16.count }
    /// At most `limit` of those, never cutting a character in half.
    static func clipped(_ s: String) -> String { clippedUTF16(s, limit) }

    var body: some View {
        if let email = app.email {
            compose(email)
        } else {
            SettingsGroup(title: L("Add your email to send feedback"), hint: L("So we can reply to you. Your setup stays as it is.")) {
                Button(L("Add your email"), action: settingsAddEmail)
                    .buttonStyle(SettingsInkButtonStyle(full: true))
                    .padding(16)
                    .accessibilityIdentifier("settings.addEmail")
            }
        }
    }

    private func compose(_ email: String) -> some View {
        let n = Self.length(note)
        let canSend = !note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !sending
        return VStack(alignment: .leading, spacing: 14) {
            VStack(spacing: 0) {
                HStack(spacing: 12) {
                    Text(L("From")).foregroundStyle(Color.muted)
                    Text(email).foregroundStyle(Color.ink).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 16)
                .frame(minHeight: 48)
                GroupDivider(inset: 0)
                ZStack(alignment: .topLeading) {
                    if note.isEmpty {
                        Text(L("Ideas, problems, anything: a place you want to go, something that confused you…"))
                            .foregroundStyle(Color.faint)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 12)
                            .allowsHitTesting(false)
                            .accessibilityHidden(true)
                    }
                    TextEditor(text: $note)
                        .focused($focused)
                        .scrollContentBackground(.hidden)
                        .padding(.horizontal, 11)
                        .padding(.vertical, 4)
                        .frame(minHeight: 160)
                        .onChange(of: note) { _, v in
                            if Self.length(v) > Self.limit { note = Self.clipped(v) }
                            if !v.isEmpty { sent = false }
                        }
                        .accessibilityLabel(L("Ideas, problems, anything"))
                        .accessibilityIdentifier("settings.feedbackNote")
                }
                GroupDivider(inset: 0)
                HStack {
                    Text(verbatim: "\(n) / \(Self.limit)")
                        .font(.footnote.monospacedDigit())
                        .foregroundStyle(n >= Self.near ? Color.warn : Color.muted)
                        .accessibilityLabel(L("%@ of %@ characters", "\(n)", "\(Self.limit)"))
                    Spacer()
                    Button(sending ? L("Sending…") : L("Send")) {
                        sending = true
                        result = nil
                        focused = false
                        Task {
                            result = await model.sendFeedback(note)
                            sent = result == nil
                            if sent { note = "" }
                            sending = false
                        }
                    }
                    .buttonStyle(SettingsInkButtonStyle())
                    .disabled(!canSend)
                    .accessibilityIdentifier("settings.feedbackSend")
                }
                .padding(.leading, 16)
                .padding(.trailing, 10)
                .padding(.vertical, 8)
            }
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line))
            if sent {
                SettingsHint(L("Thanks. Your feedback was sent.")).padding(.horizontal, 4).announced(L("Thanks. Your feedback was sent."))
            }
            if let result { SettingsHint(result, color: .bad).padding(.horizontal, 4).announced(result) }
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: "exclamationmark.bubble").font(.title3).foregroundStyle(Color.muted).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(L("A wrong answer?")).fontWeight(.medium).foregroundStyle(Color.ink)
                    SettingsHint(L("Press \"Is this wrong?\" under it, so we see what you saw."))
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color.line))
            .accessibilityElement(children: .combine)
        }
    }
}
