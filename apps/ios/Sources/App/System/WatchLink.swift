import Foundation
import Observation
import WatchConnectivity

/// The iPhone's end of WatchConnectivity: "Set up your watch" in Settings ›
/// Devices gets a pairing code and sends it to the watch, which redeems it
/// for a session of its own (ADR 0016). The watch says whether it's signed
/// in (WatchHandoff), so after this phone signs in with an email, which
/// ends a setup's other sessions on the server, a watch it had set up
/// gets a fresh code without being asked.
@MainActor @Observable
final class WatchLink: NSObject, WCSessionDelegate {
    static let shared = WatchLink()

    /// A watch is paired with this phone, and has terminus on it.
    private(set) var paired = false
    private(set) var installed = false
    /// What the watch last said; nil before it has said anything.
    private(set) var watch: WatchHandoff.State?
    private(set) var sending = false
    /// Said under the button: sent, or why not.
    private(set) var result: String?

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// Gets a pairing code with `token` and sends it to the watch, which
    /// signs in with it when it next can.
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
                WCSession.default.transferUserInfo(
                    WatchHandoff.message(WatchHandoff.Code(code: code, lang: Lang.pref, clock: Clock.pref, sentAt: Date())))
                result = L("Sent. Open terminus on your watch.")
            } catch {
                result = failureMessage(error)
            }
        }
    }

    /// This phone signed in with an email: a watch that was signed in has
    /// lost its session with the setup's other ones, so it gets a fresh
    /// code. Not one signed out by its own Sign out.
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

    /// Switched to another watch: the session starts again for it.
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        session.activate()
    }
}
