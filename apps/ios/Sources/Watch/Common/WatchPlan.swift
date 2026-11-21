import Foundation
import WidgetKit

enum WatchPlan {
    static func kept() -> (NextAnswer, Date)? {
        WidgetStore.plan().map { ($0.0, $0.1.addingTimeInterval(ServerClock.skew)) }
    }

    static func due(now: Date = ServerClock.now) -> Bool {
        let k = kept()
        return WidgetTiming.due(k?.0, fetchedAt: k?.1, now: now)
    }

    static func refreshIfDue() async {
        guard TokenStore.read() != nil, Date() >= Quiet.until(.app), due() else { return }
        await refresh()
    }

    private static let fetching = Mutex<Task<Void, Never>?>(nil)

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

    @discardableResult
    static func follow(_ contentLanguage: String?) -> Bool {
        guard let c = contentLanguage else { return false }
        let pref = c.hasPrefix("zh") ? "zh" : "en"
        guard Lang.pref != pref else { return false }
        Lang.pref = pref
        return true
    }

    static func redraw() {
        WidgetCenter.shared.reloadAllTimelines()
    }

    static var inExtension: Bool { Bundle.main.bundlePath.hasSuffix(".appex") }
}

enum WatchSession {
    private static var d: UserDefaults { Shared.defaults }

    static var signedOutReason: String? {
        get { d.string(forKey: "watch.signedOutReason") }
        set { d.set(newValue, forKey: "watch.signedOutReason") }
    }

    static var out: WatchHandoff.Out? {
        get { d.string(forKey: "watch.out").flatMap(WatchHandoff.Out.init) }
        set { d.set(newValue?.rawValue, forKey: "watch.out") }
    }

    static var state: WatchHandoff.State { WatchHandoff.State(signedIn: TokenStore.read() != nil, out: out) }

    static func signedIn(token: String, lang: String, clock: String) {
        clearLocal()
        TokenStore.save(token)
        Lang.pref = lang
        Clock.pref = clock
        signedOutReason = nil
        out = nil
        WatchPlan.redraw()
    }

    static func rejected(_ token: String) {
        guard TokenStore.read() == token else { return }
        clearLocal()
        signedOutReason = signedOutHere
        out = .server
        WatchPlan.redraw()
    }

    static func signOut() {
        let token = TokenStore.read()
        clearLocal()
        signedOutReason = nil
        out = .you
        WatchPlan.redraw()
        if let token { Task.detached { try? await Api(token: token).logout() } }
    }

    private static func clearLocal() {
        TokenStore.clear()
        WidgetStore.forget()
        Shared.lastAnswer = nil
        Shared.lastDay = nil
    }
}
