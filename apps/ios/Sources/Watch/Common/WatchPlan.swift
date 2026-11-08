import Foundation
import WidgetKit

/// The watch's plan: one answer from /api/me/next, kept in the app group
/// (WidgetStore) for the app and its complications alike, and fetched by
/// whichever of them needs it first, by the iPhone widget's rules
/// (WidgetTiming): at the answer's next moment, else after 15 minutes,
/// and a complication's timeline never reloaded sooner than 5 minutes
/// apart. The open app also asks when it appears and at the next moment.
/// Every request goes through the edge cache and the feed gate on the
/// server (rule 2); nothing here polls.
enum WatchPlan {
    /// The plan as kept, with when it came on the server's clock.
    static func kept() -> (NextAnswer, Date)? {
        WidgetStore.plan().map { ($0.0, $0.1.addingTimeInterval(ServerClock.skew)) }
    }

    /// Whether the kept plan is due a fetch now (WidgetTiming.due).
    static func due(now: Date = ServerClock.now) -> Bool {
        let k = kept()
        return WidgetTiming.due(k?.0, fetchedAt: k?.1, now: now)
    }

    /// A fetch when the kept plan is due one, and not while the server has
    /// asked for quiet: what a complication's timeline does each time.
    static func refreshIfDue() async {
        guard TokenStore.read() != nil, Date() >= Quiet.until(.app), due() else { return }
        await refresh()
    }

    /// The fetch in flight in this process, if any: the app and a timeline
    /// asking at once share it.
    private static let fetching = Mutex<Task<Void, Never>?>(nil)

    /// Fetches the plan once, unless it came within `WidgetStore.recent`
    /// (another process, a moment ago), and keeps it.
    static func refresh() async {
        if let (_, at) = WidgetStore.plan(), -at.timeIntervalSinceNow < WidgetStore.recent, WidgetStore.error == nil { return }
        let task = fetching.withLock { t in
            if let t { return t }
            let new = Task {
                await fetch()
                fetching.withLock { $0 = nil }
            }
            t = new
            return new
        }
        await task.value
    }

    private static func fetch() async {
        guard let token = TokenStore.read() else { return }
        let loc = WidgetStore.location
        let written = Mutex<String?>(nil)
        do {
            let a = try await Api(token: token, fast: inExtension).next(.plan, lat: loc?.lat, lon: loc?.lon, acc: loc?.acc) { r in
                written.withLock { $0 = r.value(forHTTPHeaderField: "content-language") }
            }
            guard TokenStore.read() == token else { return }
            WidgetStore.keep(a)
            follow(written.withLock { $0 })
        } catch let e as ApiError where e.status == 401 {
            WatchSession.rejected(token)
        } catch let e as ApiError {
            WidgetStore.error = e.message
        } catch is DecodingError {
            WidgetStore.error = L("Unexpected response from terminus")
        } catch {
            WidgetStore.error = L("Offline")
        }
    }

    /// The account's language, from the language an answer is written in
    /// (`content-language`): the account's choice decides it over the one
    /// asked in, so the watch's own few words follow the account's. True
    /// when it changed.
    @discardableResult
    static func follow(_ contentLanguage: String?) -> Bool {
        guard let c = contentLanguage else { return false }
        let pref = c.hasPrefix("zh") ? "zh" : "en"
        guard Lang.pref != pref else { return false }
        Lang.pref = pref
        return true
    }

    /// The complications, drawn again from what's kept; asked after the app
    /// fetched or signed in or out, never on a timer.
    static func redraw() {
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// This runs in the complications' extension, which has seconds, not ten.
    static var inExtension: Bool { Bundle.main.bundlePath.hasSuffix(".appex") }
}

/// The watch's own sign-in: its token in its keychain (TokenStore), from a
/// pairing code the iPhone sent. Signing out is the watch's alone: its Sign
/// out, or the server refusing its token (removed in Devices, the account
/// deleted). The phone signing out leaves it signed in.
enum WatchSession {
    private static var d: UserDefaults { Shared.defaults }

    /// Why the watch was signed out, said once on the setup screen; nil after its own Sign out.
    static var signedOutReason: String? {
        get { d.string(forKey: "watch.signedOutReason") }
        set { d.set(newValue, forKey: "watch.signedOutReason") }
    }

    /// How it was last signed out, for the phone (WatchHandoff.State); nil while signed in or never.
    static var out: WatchHandoff.Out? {
        get { d.string(forKey: "watch.out").flatMap(WatchHandoff.Out.init) }
        set { d.set(newValue?.rawValue, forKey: "watch.out") }
    }

    static var state: WatchHandoff.State { WatchHandoff.State(signedIn: TokenStore.read() != nil, out: out) }

    /// A token from a redeemed code: kept, with what the phone's settings were.
    static func signedIn(token: String, lang: String, clock: String) {
        clearLocal()
        TokenStore.save(token)
        Lang.pref = lang
        Clock.pref = clock
        signedOutReason = nil
        out = nil
        WatchPlan.redraw()
    }

    /// The server refused `token` while it was still this watch's.
    static func rejected(_ token: String) {
        guard TokenStore.read() == token else { return }
        clearLocal()
        signedOutReason = signedOutHere
        out = .server
        WatchPlan.redraw()
    }

    /// Its own Sign out: the server told when it can be.
    static func signOut() {
        let token = TokenStore.read()
        clearLocal()
        signedOutReason = nil
        out = .you
        WatchPlan.redraw()
        if let token { Task.detached { try? await Api(token: token).logout() } }
    }

    /// Everything the account left on the watch.
    private static func clearLocal() {
        TokenStore.clear()
        WidgetStore.forget()
        Shared.lastAnswer = nil
        Shared.lastDay = nil
    }
}
