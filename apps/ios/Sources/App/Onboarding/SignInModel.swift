import Foundation
import Observation

/// The codes people type: the one in a sign-in email and a pairing code, both
/// six letters and digits from the same alphabet (accounts.ts PAIR_ALPHABET,
/// applogin.ts), and the address the code goes to.
enum SignInCode {
    static let length = 6
    /// No 0/O or 1/I/L to misread.
    static let alphabet = Set("23456789ABCDEFGHJKMNPQRSTVWXYZ")

    /**
     What the boxes hold after the field changed from `old` to `new`:
     capitals, letters and digits only, at most six, filling from the left so
     each character typed moves on to the next box.

     A paste (more than one character arriving at once) may bring words with
     it, or land after what was already typed: "Your code is 7KQ2XM", or
     "AB7KQ2XM". Then the code is the last six-character word that could be
     one (so not "WITHIN"), else the last six letters and digits ("7KQ 2XM"
     and "7KQ-2XM" too). As Android's codeEdit.
     */
    static func edit(old: String, new: String) -> String {
        let up = new.uppercased()
        let chars = up.filter(isCodeChar)
        if chars.count - old.count <= 1 { return String(chars.prefix(length)) }
        let words = up.split(whereSeparator: { !isCodeChar($0) })
        if let w = words.last(where: { $0.count == length && $0.allSatisfy { alphabet.contains($0) } }) { return String(w) }
        return String(chars.suffix(length))
    }

    private static func isCodeChar(_ c: Character) -> Bool {
        c.isASCII && (c.isNumber || ("A"..."Z").contains(c))
    }

    /// A simple local@domain.tld: enough to catch a typo before anything is sent.
    static func looksLikeEmail(_ s: String) -> Bool {
        s.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"#, options: .regularExpression) != nil
    }

    /// The sites a pairing QR code may point at: the account page's
    /// `https://terminus.run/pair?code=…`, the beta's, either's old address,
    /// and in a debug build the stub.
    static var pairHosts: Set<String> {
        var hosts: Set<String> = ["terminus.run", "terminus.rcn.sh", "beta.terminus.run", "beta.terminus.rcn.sh"]
        for s in Servers.choices + [Api.site] { if let h = URL(string: s)?.host?.lowercased() { hosts.insert(h) } }
        return hosts
    }

    /// The pairing code in what a QR code says: a pairing link to one of our
    /// own sites, or the code alone. Nil for anything else.
    static func pairCode(scanned s: String, hosts: Set<String> = pairHosts) -> String? {
        let text = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if let url = URL(string: text), let host = url.host?.lowercased() {
            guard hosts.contains(host), url.path == "/pair" || url.path == "/pair/",
                let code = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "code" })?.value
            else { return nil }
            return valid(code)
        }
        return valid(text)
    }

    private static func valid(_ code: String) -> String? {
        let c = code.uppercased()
        return c.count == length && c.allSatisfy { alphabet.contains($0) } ? c : nil
    }
}

/// Signing in by email, approved from the email on any device: the address,
/// then the code from the email or the number shown here chosen on the page the
/// email links to. The same steps as Android's AccountViewModel. Used from the
/// welcome screen, and from Settings to add an email to an account without one
/// (`adding`): then it's sent with this phone's token, so its setup is kept or
/// offered when the account has its own.
@MainActor @Observable
final class SignInModel {
    enum Step: Equatable {
        /// Typing the address.
        case email
        /// The email is sent: show `match` and wait for the approval.
        case waiting(email: String, match: Int)
        /// Approved, and both this phone and the account have a setup: which one stays?
        case choose(email: String)
    }

    private(set) var step = Step.email
    private(set) var busy = false
    /// What went wrong, under the button; typing again takes it away.
    var message: String?
    let adding: Bool

    private var request: SignInRequest?
    private var deadline: Date?
    /// This phone's token without an email, while a sign-in may fold it into another account.
    private var anonToken: String?
    private var approvedToken: String?
    private var pollTask: Task<Void, Never>?

    /// The request is good for 15 minutes; the number is asked after every 3 seconds.
    static let requestS: TimeInterval = 15 * 60
    static let pollS: TimeInterval = 3

    init(adding: Bool = false) {
        self.adding = adding
    }

    var title: String {
        switch step {
        case .waiting: L("Check your email")
        case .choose: L("Which setup?")
        case .email: adding ? L("Add your email") : L("Sign in")
        }
    }

    /// Emails a code and an approval link.
    func send(_ email: String, signedIn: @escaping @MainActor () -> Void) {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !busy, SignInCode.looksLikeEmail(address) else { return }
        busy = true
        message = nil
        anonToken = AppModel.shared.token
        Task {
            defer { busy = false }
            do {
                let r = try await Api(token: anonToken).signInStart(email: address, name: deviceName())
                request = r
                deadline = Date().addingTimeInterval(Self.requestS)
                step = .waiting(email: address, match: r.match)
                poll(signedIn: signedIn)
            } catch {
                message = failureMessage(error)
            }
        }
    }

    /// The code from the email, typed or pasted: signs in straight away when it's right.
    func enter(_ code: String, signedIn: @escaping @MainActor () -> Void) {
        guard let r = request, !busy, code.count == SignInCode.length else { return }
        busy = true
        message = nil
        Task {
            do {
                let p = try await Api(token: nil).signInCode(r, code: code)
                if p.status == "approved", let token = p.token, let email = p.email {
                    pollTask?.cancel()
                    await approved(token: token, email: email, outcome: p.outcome, signedIn: signedIn)
                } else {
                    busy = false
                }
            } catch let e as ApiError where e.state == "denied" || e.state == "expired" {
                // Too many wrong codes, or too late: this request is done with.
                restart(e.message)
            } catch {
                busy = false
                message = failureMessage(error)
            }
        }
    }

    /// "Use a different email": back to the address, dropping the request sent.
    func differentEmail() { restart(nil) }

    /// Leaving the page: nothing more is asked.
    func cancel() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// Back on screen (the app opened again after the email was read on this
    /// phone): asks at once rather than after the next wait.
    func resume(signedIn: @escaping @MainActor () -> Void) {
        guard case .waiting = step, request != nil else { return }
        poll(signedIn: signedIn, now: true)
    }

    private func restart(_ why: String?) {
        pollTask?.cancel()
        request = nil
        deadline = nil
        busy = false
        step = .email
        message = why
    }

    private func poll(signedIn: @escaping @MainActor () -> Void, now: Bool = false) {
        pollTask?.cancel()
        guard let r = request, let until = deadline else { return }
        pollTask = Task {
            var first = now
            while Date() < until {
                if !first { try? await Task.sleep(for: .seconds(Self.pollS)) }
                first = false
                if Task.isCancelled { return }
                // Offline for a moment, or told to wait: keep waiting.
                guard let p = try? await Api(token: nil).signInPoll(r) else { continue }
                if Task.isCancelled { return }
                switch p.status {
                case "pending":
                    continue
                case "approved":
                    // Approved always comes with both; one without is an answer this version can't use.
                    if let token = p.token, let email = p.email {
                        await approved(token: token, email: email, outcome: p.outcome, signedIn: signedIn)
                        return
                    }
                case "denied":
                    restart(L("The sign-in was cancelled from the email. If that was you, send a new one."))
                    return
                default:
                    break
                }
                break
            }
            if !Task.isCancelled { restart(L("That request expired. Send a new one.")) }
        }
    }

    private func approved(token: String, email: String, outcome: String?, signedIn: @escaping @MainActor () -> Void) async {
        request = nil
        if outcome == "choose" {
            // Both have a setup: the old token stays until the choice is made.
            approvedToken = token
            busy = false
            step = .choose(email: email)
            return
        }
        await finish(token: token, email: email, signedIn: signedIn)
    }

    /// After "choose": the account's setup, or this phone's.
    func choose(keepPhone: Bool, signedIn: @escaping @MainActor () -> Void) {
        guard let token = approvedToken, case .choose(let email) = step, !busy else { return }
        busy = true
        message = nil
        let anon = anonToken
        Task {
            do {
                if let anon { try await Api(token: token).merge(anon: anon, keepDevice: keepPhone) }
                await finish(token: token, email: email, signedIn: signedIn)
            } catch {
                busy = false
                message = failureMessage(error)
            }
        }
    }

    /// Signed in: a new account, or one never set up, goes through setup.
    private func finish(token: String, email: String, signedIn: @escaping @MainActor () -> Void) async {
        busy = true
        approvedToken = nil
        anonToken = nil
        let me = try? await Api(token: token).me()
        AppModel.shared.signedIn(token: token, anonymous: false, email: me?.email ?? email, needsSetup: me?.onboarding != nil)
        busy = false
        signedIn()
    }
}

/// The welcome screen's own work: starting without an account, and pairing
/// with a code from a signed-in device.
@MainActor @Observable
final class WelcomeModel {
    /// One for the app, so a pairing link (Links) can ask through the welcome screen.
    static let shared = WelcomeModel()

    private(set) var starting = false
    private(set) var pairing = false
    /// Why the last attempt didn't work, said on the screen it came from.
    var message: String?
    var pairError: String?
    /// A pairing link opened: whose account it is, waiting for a yes.
    var pendingPair: (code: String, account: String)?

    /// "Get started": an account with no email, made for this phone.
    func start() {
        guard !starting else { return }
        starting = true
        message = nil
        Task {
            defer { starting = false }
            do {
                let token = try await Api(token: nil).anon(name: deviceName())
                AppModel.shared.signedIn(token: token, anonymous: true, needsSetup: true)
            } catch {
                message = failureMessage(error)
            }
        }
    }

    func pair(_ code: String) {
        guard !pairing, code.count == SignInCode.length else { return }
        pairing = true
        pairError = nil
        pendingPair = nil
        Task {
            defer { pairing = false }
            do {
                let token = try await Api(token: nil).pair(code: code, name: deviceName())
                // Pairing codes come from accounts with an email; one never set up goes through setup.
                let me = try? await Api(token: token).me()
                AppModel.shared.signedIn(token: token, anonymous: false, email: me?.email, needsSetup: me?.onboarding != nil)
            } catch {
                pairError = failureMessage(error)
            }
        }
    }

    /**
     A pairing link opened the app with a code someone made. Whose account it
     is shows first, and waits for a yes: otherwise any link could quietly
     pair this phone to a stranger's account.
     */
    func checkPairLink(_ code: String) {
        guard !AppModel.shared.paired, !pairing else { return }
        pairing = true
        pairError = nil
        Task {
            defer { pairing = false }
            do {
                pendingPair = (code, try await Api(token: nil).pairCheck(code: code))
            } catch {
                pairError = failureMessage(error)
            }
        }
    }
}
