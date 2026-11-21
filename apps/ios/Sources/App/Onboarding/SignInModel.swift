import Foundation
import Observation

enum SignInCode {
    static let length = 6
    static let alphabet = Set("23456789ABCDEFGHJKMNPQRSTVWXYZ")

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

    static func looksLikeEmail(_ s: String) -> Bool {
        s.trimmingCharacters(in: .whitespacesAndNewlines).range(of: #"^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$"#, options: .regularExpression) != nil
    }

    static var pairHosts: Set<String> {
        var hosts: Set<String> = ["terminus.run", "beta.terminus.run"]
        for s in Servers.choices + [Api.site] { if let h = URL(string: s)?.host?.lowercased() { hosts.insert(h) } }
        return hosts
    }

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

@MainActor @Observable
final class SignInModel {
    enum Step: Equatable {
        case email
        case waiting(email: String, match: Int)
        case choose(email: String)
    }

    private(set) var step = Step.email
    private(set) var busy = false
    var message: String?
    let adding: Bool

    private var request: SignInRequest?
    private var deadline: Date?
    private var anonToken: String?
    private var approvedToken: String?
    private var pollTask: Task<Void, Never>?

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
                restart(e.message)
            } catch {
                busy = false
                message = failureMessage(error)
            }
        }
    }

    func differentEmail() { restart(nil) }

    func cancel() {
        pollTask?.cancel()
        pollTask = nil
    }

    func resume(signedIn: @escaping @MainActor () -> Void) {
        guard case .waiting = step, request != nil else { return }
        poll(signedIn: signedIn, now: true)
    }

    nonisolated static func givesUp(_ status: Int) -> Bool { (400..<500).contains(status) && status != 429 }

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
                let p: SignInPoll
                do {
                    p = try await Api(token: nil).signInPoll(r)
                } catch let e as ApiError where Self.givesUp(e.status) {
                    restart(e.message)
                    return
                } catch {
                    continue
                }
                if Task.isCancelled { return }
                switch p.status {
                case "pending":
                    continue
                case "expired" where busy:
                    continue
                case "approved":
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
            approvedToken = token
            busy = false
            step = .choose(email: email)
            return
        }
        await finish(token: token, email: email, signedIn: signedIn)
    }

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

    private func finish(token: String, email: String, signedIn: @escaping @MainActor () -> Void) async {
        busy = true
        approvedToken = nil
        anonToken = nil
        let me = try? await Api(token: token).me()
        AppModel.shared.signedIn(token: token, anonymous: false, email: me?.email ?? email, needsSetup: me.map { $0.onboarding != nil })
        busy = false
        signedIn()
    }
}

@MainActor @Observable
final class WelcomeModel {
    static let shared = WelcomeModel()

    private(set) var starting = false
    private(set) var pairing = false
    var message: String?
    var pairError: String?
    var pendingPair: (code: String, account: String)?

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
                let me = try? await Api(token: token).me()
                AppModel.shared.signedIn(token: token, anonymous: false, email: me?.email, needsSetup: me.map { $0.onboarding != nil })
            } catch {
                pairError = failureMessage(error)
            }
        }
    }

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
