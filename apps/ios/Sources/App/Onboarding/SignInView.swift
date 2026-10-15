import SwiftUI

/// Sign in by email, approved from the email on any device: type the address,
/// then the code from the email, or choose the number shown here on the page
/// the email links to. As Settings' pages: the title in a band of the sky, then
/// the plain page. Pushed from the welcome screen; in Settings, inside
/// [SignInSheet]. `done` runs once this phone is signed in.
struct SignInView: View {
    @State var model: SignInModel
    var done: @MainActor () -> Void
    @Environment(\.scenePhase) private var scenePhase

    init(model: SignInModel, done: @escaping @MainActor () -> Void) {
        _model = State(initialValue: model)
        self.done = done
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                SkyBand {
                    Text(model.title)
                        .font(.largeTitle.bold())
                        .accessibilityAddTraits(.isHeader)
                        .padding(.horizontal, 20)
                        .padding(.top, 8)
                }
                VStack(alignment: .leading, spacing: 22) {
                    switch model.step {
                    case .email: EmailStep(model: model, done: done)
                    case .waiting(let email, let match): WaitingStep(model: model, email: email, match: match, done: done)
                    case .choose(let email): ChooseStep(model: model, email: email, done: done)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 20)
                .padding(.bottom, 32)
                .animation(.default, value: model.step)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Color.page.ignoresSafeArea())
        .navigationBarTitleDisplayMode(.inline)
        .skyStatusBar()
        .onDisappear { model.cancel() }
        .onChange(of: scenePhase) { _, phase in if phase == .active { model.resume(signedIn: done) } }
    }
}

/// For Settings: adds an email to this phone's account without one, the same
/// pages in a sheet, with Cancel. On success the account is this phone's with
/// its email (AppModel.signedIn), and the sheet closes.
struct SignInSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var model = SignInModel(adding: true)

    var body: some View {
        NavigationStack {
            SignInView(model: model) { dismiss() }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button(L("Cancel")) { dismiss() }
                    }
                }
        }
    }
}

/// A group of the page: its name above a card, and what it's for under it, as in Settings.
private struct SignInGroup<Content: View>: View {
    let title: String
    var footer: String?
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionLabel(title).padding(.horizontal, 4)
            VStack(alignment: .leading, spacing: 0) { content }
                .cardStyle(padding: 14)
            if let footer {
                Text(footer)
                    .font(.footnote)
                    .foregroundStyle(Color.muted)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
            }
        }
    }
}

/// The main button, across the page, and what went wrong under it.
private struct SignInAction: View {
    let text: String
    let enabled: Bool
    let message: String?
    var id = "signIn.action"
    let action: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(text, action: action)
                .buttonStyle(.primary)
                .disabled(!enabled)
                .accessibilityIdentifier(id)
            if let message {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(Color.bad)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 4)
                    .announced(message)
                    .accessibilityIdentifier("signIn.message")
            }
        }
    }
}

private struct EmailStep: View {
    let model: SignInModel
    let done: @MainActor () -> Void
    @State private var email = ""
    @FocusState private var focused: Bool

    var body: some View {
        let ok = SignInCode.looksLikeEmail(email)
        SignInGroup(
            title: L("Your email"),
            footer: model.adding
                ? L("Keeps your settings if you lose this phone, and lets you use terminus on your Mac or the web.")
                : L("Use the email you set up terminus with. We'll email you a code to type here.")
        ) {
            TextField(L("Email"), text: $email, prompt: Text(L("you@u.nus.edu")))
                .font(.body)
                .keyboardType(.emailAddress)
                .textContentType(.emailAddress)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.send)
                .focused($focused)
                .frame(minHeight: 30)
                .onSubmit { if ok { model.send(email, signedIn: done) } }
                .onChange(of: email) { if model.message != nil { model.message = nil } }
                .accessibilityIdentifier("signIn.email")
        }
        SignInAction(text: model.busy ? L("Sending…") : L("Email me a code"), enabled: ok && !model.busy, message: model.message) {
            model.send(email, signedIn: done)
        }
        .onAppear { focused = true }
    }
}

private struct WaitingStep: View {
    let model: SignInModel
    let email: String
    let match: Int
    let done: @MainActor () -> Void
    @State private var code = ""

    var body: some View {
        SignInGroup(
            title: L("Code from the email"),
            footer: L("Sent to %@. Not there after a minute? Check your spam folder. The code works for 15 minutes.", email)
        ) {
            SignInCodeBoxes(code: $code, label: L("Code from the email")) {
                if code.count == SignInCode.length { model.enter(code, signedIn: done) }
            }
            .onChange(of: code) { old, new in
                if model.message != nil { model.message = nil }
                // The sixth character, typed or pasted, sends it.
                if new.count == SignInCode.length && old.count < SignInCode.length { model.enter(new, signedIn: done) }
            }
        }
        SignInAction(
            text: model.busy ? L("Checking…") : L("Sign in"), enabled: code.count == SignInCode.length && !model.busy,
            message: model.message
        ) {
            model.enter(code, signedIn: done)
        }
        // Or approve it from the email on another device, by the number shown here.
        SignInGroup(title: L("Reading it on another device?")) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(L("Open the link in the email, then choose"))
                        .font(.body)
                        .foregroundStyle(Color.ink)
                    Text(L("This phone signs in by itself once you do."))
                        .font(.footnote)
                        .foregroundStyle(Color.muted)
                }
                .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Text(verbatim: "\(match)")
                    .font(.system(size: 30, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(Color.brand)
                    .frame(minWidth: 64, minHeight: 56)
                    .padding(.horizontal, 8)
                    .background(Color.surface2, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityLabel(L("The number to choose: %@", "\(match)"))
                    .accessibilityIdentifier("signIn.match")
            }
            .accessibilityElement(children: .combine)
        }
        Button(L("Use a different email")) { model.differentEmail() }
            .font(.subheadline.weight(.medium))
            .foregroundStyle(Color.muted)
            .frame(maxWidth: .infinity, minHeight: 44)
    }
}

private struct ChooseStep: View {
    let model: SignInModel
    let email: String
    let done: @MainActor () -> Void

    var body: some View {
        Text(L("%@ already has a timetable and settings, and so does this phone. Keep one:", email))
            .font(.body)
            .foregroundStyle(Color.ink)
            .fixedSize(horizontal: false, vertical: true)
            .padding(.horizontal, 4)
        VStack(alignment: .leading, spacing: 10) {
            SignInAction(text: L("Keep my account's setup"), enabled: !model.busy, message: model.message, id: "signIn.keepAccount") {
                model.choose(keepPhone: false, signedIn: done)
            }
            Button(L("Replace it with this phone's")) { model.choose(keepPhone: true, signedIn: done) }
                .buttonStyle(.secondary)
                .disabled(model.busy)
                .accessibilityIdentifier("signIn.keepPhone")
            Text(L("Replacing changes it on every device signed in to %@.", email))
                .font(.footnote)
                .foregroundStyle(Color.muted)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 4)
        }
    }
}

/// The code from the email in six boxes. One text field takes the keys,
/// pastes, deletes and the keyboard's suggestion of a code from Mail, drawn as
/// the boxes: each character typed fills the next box, a pasted code spreads
/// over all six (SignInCode.edit), and the box that's next is outlined in the ink.
struct SignInCodeBoxes: View {
    @Binding var code: String
    let label: String
    var submit: () -> Void = {}
    @FocusState private var focused: Bool

    var body: some View {
        ZStack {
            // The field itself, unseen behind the boxes: it's what the keyboard and Paste reach.
            TextField("", text: Binding(get: { code }, set: { code = SignInCode.edit(old: code, new: $0) }))
                .keyboardType(.asciiCapable)
                .textContentType(.oneTimeCode)
                .textInputAutocapitalization(.characters)
                .autocorrectionDisabled()
                .submitLabel(.go)
                .onSubmit(submit)
                .focused($focused)
                .foregroundStyle(.clear)
                .tint(.clear)
                .accessibilityLabel(label)
                .accessibilityValue(code.map(String.init).joined(separator: " "))
                .accessibilityIdentifier("signIn.code")
            HStack(spacing: 8) {
                ForEach(0..<SignInCode.length, id: \.self) { i in
                    let chars = Array(code)
                    let next = focused && i == min(chars.count, SignInCode.length - 1)
                    Text(i < chars.count ? String(chars[i]) : "")
                        .font(.system(size: 24, weight: .semibold, design: .monospaced))
                        .foregroundStyle(Color.ink)
                        .frame(maxWidth: .infinity, minHeight: 54)
                        .background(Color.page, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .overlay(
                            RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(
                                next ? Color.ink : Color.line, lineWidth: next ? 2 : 1.5))
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
        .onAppear { focused = true }
    }
}
