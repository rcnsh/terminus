import Foundation

/// What the iPhone and its watch say to each other over WatchConnectivity,
/// both ways, as plain dictionaries. The phone sends a pairing code (with
/// its language and 12- or 24-hour choice, so the watch starts in them)
/// by `transferUserInfo`, which waits for the watch if it's away; the watch
/// says whether it's signed in by its application context, the latest of
/// which the phone can read at any time. The token itself never crosses:
/// the watch redeems the code for a session of its own (ADR 0016).
enum WatchHandoff {
    /// A code is good for 10 minutes on the server; one older than that
    /// (a transfer that waited for a watch left off) isn't tried.
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

    /// The code in a message from the phone, unless it has run out or isn't one.
    static func code(in m: [String: Any], now: Date = Date()) -> Code? {
        guard let code = m["pairCode"] as? String, !code.isEmpty, let at = m["sentAt"] as? Double else { return nil }
        let sentAt = Date(timeIntervalSince1970: at)
        guard now.timeIntervalSince(sentAt) < codeLife else { return nil }
        return Code(code: code, lang: m["lang"] as? String ?? "auto", clock: m["clock"] as? String ?? "auto", sentAt: sentAt)
    }

    /// How the watch came to be signed out: by its own Sign out, or by the
    /// server (removed in Devices, the account deleted or merged).
    enum Out: String {
        case you, server
    }

    /// The watch's state, for the phone.
    struct State: Equatable {
        let signedIn: Bool
        var out: Out? = nil
    }

    static func context(_ s: State) -> [String: Any] {
        var m: [String: Any] = ["watchSignedIn": s.signedIn]
        if let out = s.out { m["signedOutBy"] = out.rawValue }
        return m
    }

    /// The watch's last word, or nil before it has said anything (not opened since it was installed).
    static func state(in m: [String: Any]) -> State? {
        guard let signedIn = m["watchSignedIn"] as? Bool else { return nil }
        return State(signedIn: signedIn, out: (m["signedOutBy"] as? String).flatMap(Out.init))
    }
}
