import SwiftUI
import os

// MARK: - Pairing

struct Pair: View {
    @Bindable var model: AppModel
    @State private var code = ""
    @State private var email = ""
    @State private var useCode = false
    @State private var emailCode = ""

    private var emailOK: Bool { email.trimmingCharacters(in: .whitespaces).range(of: #"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"#, options: .regularExpression) != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 12) {
                IconTile(system: "bus.fill")
                VStack(alignment: .leading, spacing: 2) {
                    Wordmark()
                    StatusLine(color: .gray, text: L("Not signed in"))
                }
            }
            .card()

            if let w = model.signInWaiting {
                waiting(w.email, w.match)
            } else if useCode {
                pairCard
            } else {
                emailCard
            }
        }
    }

    /// Sign in with the email: approved from any device, the phone's mail app included.
    private var emailCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel(text: L("Sign in"))
            Text(L("Use the email you set up terminus with. We'll send you a code to enter here."))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("you@u.nus.edu", text: $email)
                .textFieldStyle(.roundedBorder)
                .textContentType(.emailAddress)
                .onSubmit { if emailOK { model.signIn(email: email.trimmingCharacters(in: .whitespaces)) } }
            Button {
                model.signIn(email: email.trimmingCharacters(in: .whitespaces))
            } label: {
                Text(model.signingIn ? L("Sending…") : L("Email me a code")).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(!emailOK || model.signingIn)
            if let e = model.signInError {
                Text(e).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            Button(L("Pair with a code instead")) { useCode = true }
                .buttonStyle(.link)
                .font(.callout)
            Divider().padding(.vertical, 2)
            // As on the phone and the web: start straight away, add an email later.
            Button {
                model.startWithoutEmail()
            } label: {
                Text(model.startingAnon ? L("Starting…") : L("Use terminus without an email")).frame(maxWidth: .infinity)
            }
            .controlSize(.large)
            .disabled(model.startingAnon)
            Text(L("Your setup stays on this Mac. Add an email any time in Settings to use it on your other devices, or to keep it if this Mac is lost."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .card()
    }

    private func waiting(_ email: String, _ match: Int) -> some View {
        VStack(alignment: .center, spacing: 10) {
            SectionLabel(text: L("Check your email")).frame(maxWidth: .infinity, alignment: .leading)
            Text(L("Sent to %@. Not there after a minute? Check your spam folder. The code works for 15 minutes.", email))
                .font(.callout)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
            CodeField(code: $emailCode, label: L("Code from the email"), onEdit: { model.signInError = nil }) { model.enterCode($0) }
                .padding(.vertical, 4)
            Button {
                model.enterCode(emailCode)
            } label: {
                Text(model.signingIn ? L("Checking…") : L("Sign in")).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(emailCode.count != CodeField.length || model.signingIn)
            if let e = model.signInError {
                Text(e).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            Divider().padding(.vertical, 2)
            // The email's link, on a phone or anywhere else: choose this number there.
            Text(L("Reading it on another device?")).font(.callout.weight(.semibold))
            HStack(spacing: 10) {
                Text(L("Open the link in the email, then choose"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Text(String(match))
                    .font(.system(size: 28, weight: .bold, design: .rounded))
                    .monospacedDigit()
                    .foregroundStyle(Color.brand)
                    .accessibilityLabel(L("The number to choose: %@", "\(match)"))
            }
            Text(L("This Mac signs in by itself once you do."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button(L("Use a different email")) {
                emailCode = ""
                model.cancelSignIn()
            }
            .buttonStyle(.link)
            .font(.callout)
        }
        .frame(maxWidth: .infinity)
        .card()
    }

    private var pairCard: some View {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: L("Pair this Mac"))
                Text(L("On your phone: Settings, then Add a device. Or on %@/account: Add a device. Then enter the 6-character code here.", Api.siteHost))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                CodeField(code: $code, label: L("Pairing code"), onEdit: { model.pairError = nil }) { model.pair($0) }
                    .padding(.vertical, 4)
                Button {
                    model.pair(code)
                } label: {
                    Text(model.pairing ? L("Pairing…") : L("Pair")).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(code.count != CodeField.length || model.pairing)
                if let e = model.pairError {
                    Text(e).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
                }
                Button(L("Sign in with email instead")) { useCode = false }
                    .buttonStyle(.link)
                    .font(.callout)
            }
            .card()
    }
}

// MARK: - Code boxes

/// What the code boxes hold after the field changed from `old` to `new`, as
/// Android's `codeEdit`: capitals, letters and digits only, at most six,
/// filling the boxes from the left.
///
/// A paste (more than one character arriving at once) may bring words with
/// it, or land after what was already typed: "Your code is 7KQ2XM", or
/// "AB7KQ2XM". Then the code is the last six-character word that could be one
/// (so not "WITHIN"), else its last six letters and digits ("7KQ 2XM" too).
func codeEdit(old: String, new: String) -> String {
    let up = new.uppercased()
    let isCode = { (c: Character) in ("A"..."Z").contains(c) || ("0"..."9").contains(c) }
    let chars = String(up.filter(isCode))
    if chars.count - old.count <= 1 { return String(chars.prefix(CodeField.length)) }
    // No 0/O or 1/I/L to misread (accounts.ts PAIR_ALPHABET).
    let alphabet = Set("23456789ABCDEFGHJKMNPQRSTVWXYZ")
    let words = up.split(whereSeparator: { !isCode($0) })
    if let w = words.last(where: { $0.count == CodeField.length && $0.allSatisfy(alphabet.contains) }) { return String(w) }
    return String(chars.suffix(CodeField.length))
}

/// A six-character code (the email's, or a pairing code) in six boxes, as on
/// the phone and the web. One hidden field takes the typing and pastes, so a
/// whole line from the email lands right; the sixth character sends it.
struct CodeField: View {
    nonisolated static let length = 6

    @Binding var code: String
    let label: String
    /// Any change: the place to clear an error about the last code.
    var onEdit: () -> Void = {}
    let onComplete: (String) -> Void
    @FocusState private var focused: Bool
    /// Sent already: a stray key on full boxes doesn't send it again.
    @State private var sent: String?

    var body: some View {
        ZStack {
            TextField("", text: $code)
                .textFieldStyle(.plain)
                .focused($focused)
                .focusEffectDisabled()
                .opacity(0.02)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .accessibilityLabel(label)
                .onChange(of: code) { old, v in
                    let clean = codeEdit(old: old, new: v)
                    if clean != v { code = clean; return }
                    onEdit()
                    if clean.count < Self.length { sent = nil }
                    // The sixth character, typed or pasted, sends it.
                    else if sent != clean { sent = clean; onComplete(clean) }
                }
                .onSubmit { if code.count == Self.length { sent = code; onComplete(code) } }
            HStack(spacing: 6) {
                ForEach(0..<Self.length, id: \.self) { i in
                    box(i)
                    // Read in two halves, "7KQ 2XM", as the email sets it.
                    if i == Self.length / 2 - 1 { Spacer().frame(width: 6) }
                }
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
        .fixedSize()
        .contentShape(Rectangle())
        .simultaneousGesture(TapGesture().onEnded { focused = true })
        .onAppear { focused = true }
    }

    private func box(_ i: Int) -> some View {
        let chars = Array(code)
        let current = focused && i == min(chars.count, Self.length - 1)
        return Text(i < chars.count ? String(chars[i]) : " ")
            .font(.system(size: 22, weight: .semibold, design: .monospaced))
            .frame(width: 34, height: 42)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(.primary.opacity(0.06)))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(current ? Color.brand : .primary.opacity(0.12), lineWidth: current ? 2 : 1)
            )
            .animation(.easeOut(duration: 0.12), value: current)
    }
}
