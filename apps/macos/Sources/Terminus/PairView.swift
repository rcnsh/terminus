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
            Text(L("New to terminus? Get the Android app, or set up at %@/account, then sign in here.", Api.siteHost))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .card()
    }

    private func waiting(_ email: String, _ match: Int) -> some View {
        VStack(alignment: .center, spacing: 10) {
            SectionLabel(text: L("Check your email")).frame(maxWidth: .infinity, alignment: .leading)
            Text(L("We sent a code to %@. Type it here:", email))
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            TextField("ABC 123", text: $emailCode)
                .textFieldStyle(.plain)
                .font(.system(size: 24, weight: .semibold, design: .monospaced))
                .tracking(6)
                .multilineTextAlignment(.center)
                .padding(.vertical, 8)
                .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.primary.opacity(0.06)))
                .onChange(of: emailCode) { _, v in
                    let clean = String(v.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(6))
                    if clean != v { emailCode = clean }
                    // The sixth character, typed or pasted, sends it.
                    else if clean.count == 6 { model.enterCode(clean) }
                }
                .onSubmit { if emailCode.count == 6 { model.enterCode(emailCode) } }
            Button {
                model.enterCode(emailCode)
            } label: {
                Text(model.signingIn ? L("Checking…") : L("Sign in")).frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(emailCode.count != 6 || model.signingIn)
            if let e = model.signInError {
                Text(e).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            Text(L("Reading your email on your phone? Open the link in it, and when it asks, choose:"))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Text(String(match))
                .font(.system(size: 34, weight: .bold, design: .rounded))
                .monospacedDigit()
                .foregroundStyle(Color.brand)
                .accessibilityLabel(L("The number to choose: %@", "\(match)"))
            Text(L("This Mac will sign in automatically once you do. The code expires after 15 minutes."))
                .font(.caption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button(L("Cancel")) { model.cancelSignIn() }
        }
        .frame(maxWidth: .infinity)
        .card()
    }

    private var pairCard: some View {
            VStack(alignment: .leading, spacing: 10) {
                SectionLabel(text: L("Pair this Mac"))
                Text(L("On your phone: Settings, then Add a device. Or on %@/account: Pair a device. Then enter the 6-character code here.", Api.siteHost))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                TextField("ABC 123", text: $code)
                    .textFieldStyle(.plain)
                    .font(.system(size: 24, weight: .semibold, design: .monospaced))
                    .tracking(6)
                    .multilineTextAlignment(.center)
                    .padding(.vertical, 8)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(.primary.opacity(0.06)))
                    .onChange(of: code) { _, v in
                        let clean = String(v.uppercased().filter { $0.isLetter || $0.isNumber }.prefix(6))
                        if clean != v { code = clean }
                        // The sixth character, typed or pasted, pairs.
                        else if clean.count == 6 { model.pair(clean) }
                    }
                    .onSubmit { if code.count == 6 { model.pair(code) } }
                Button {
                    model.pair(code)
                } label: {
                    Text(model.pairing ? L("Pairing…") : L("Pair")).frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .disabled(code.count != 6 || model.pairing)
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
