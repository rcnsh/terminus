import Foundation
import Observation
import WatchConnectivity

@MainActor @Observable
final class WatchLink: NSObject, WCSessionDelegate {
    static let shared = WatchLink()

    private(set) var paired = false
    private(set) var installed = false
    private(set) var watch: WatchHandoff.State?
    private(set) var sending = false
    private(set) var result: String?

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func setUp(token: String) {
        guard !sending else { return }
        sending = true
        result = nil
        Task {
            defer { sending = false }
            do {
                let code = try await Api(token: token).pairCode()
                guard WCSession.default.activationState == .activated else {
                    result = L("Couldn't reach your watch. Try again in a moment.")
                    return
                }
                let m = WatchHandoff.message(WatchHandoff.Code(code: code, lang: Lang.pref, clock: Clock.pref, sentAt: Date()))
                try WCSession.default.updateApplicationContext(m)
                if WCSession.default.isReachable { WCSession.default.sendMessage(m, replyHandler: nil) }
                result = L("Sent. Open terminus on your watch.")
            } catch {
                result = failureMessage(error)
            }
        }
    }

    func accountChanged(token: String) {
        guard paired, installed, let w = watch, w.signedIn || w.out == .server else { return }
        setUp(token: token)
    }

    func closed() { result = nil }

    private func update(_ s: WCSession) {
        paired = s.isPaired
        installed = s.isWatchAppInstalled
        watch = WatchHandoff.state(in: s.receivedApplicationContext)
    }

    nonisolated func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        Task { @MainActor in self.update(WCSession.default) }
    }

    nonisolated func sessionWatchStateDidChange(_ session: WCSession) {
        Task { @MainActor in self.update(WCSession.default) }
    }

    nonisolated func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        Task { @MainActor in self.update(WCSession.default) }
    }

    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}

    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}
