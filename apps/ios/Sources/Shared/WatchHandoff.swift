import Foundation

enum WatchHandoff {
    static let codeLife: TimeInterval = 10 * 60

    struct Code: Equatable {
        let code: String
        let lang: String
        let clock: String
        let sentAt: Date
    }

    static func message(_ c: Code) -> [String: Any] {
        ["pairCode": c.code, "lang": c.lang, "clock": c.clock, "sentAt": c.sentAt.timeIntervalSince1970]
    }

    static func code(in m: [String: Any], tried: String? = nil, now: Date = Date()) -> Code? {
        guard let code = m["pairCode"] as? String, !code.isEmpty, code != tried, let at = m["sentAt"] as? Double else { return nil }
        let sentAt = Date(timeIntervalSince1970: at)
        guard now.timeIntervalSince(sentAt) < codeLife else { return nil }
        return Code(code: code, lang: m["lang"] as? String ?? "auto", clock: m["clock"] as? String ?? "auto", sentAt: sentAt)
    }

    enum Out: String {
        case you, server
    }

    struct State: Equatable {
        let signedIn: Bool
        var out: Out? = nil
    }

    static func context(_ s: State) -> [String: Any] {
        var m: [String: Any] = ["watchSignedIn": s.signedIn]
        if let out = s.out { m["signedOutBy"] = out.rawValue }
        return m
    }

    static func state(in m: [String: Any]) -> State? {
        guard let signedIn = m["watchSignedIn"] as? Bool else { return nil }
        return State(signedIn: signedIn, out: (m["signedOutBy"] as? String).flatMap(Out.init))
    }
}
