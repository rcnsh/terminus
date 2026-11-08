import Foundation
import WatchConnectivity

/// The watch's end of WatchConnectivity: a pairing code from the iPhone is
/// redeemed (WatchModel.redeem), and the watch tells the phone whether
/// it's signed in, so the phone can send a fresh code when the watch needs
/// one (WatchHandoff).
final class PhoneLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    static let shared = PhoneLink()

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    /// The watch's state, as the phone reads it: sent whenever it changes.
    func report() {
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        try? s.updateApplicationContext(WatchHandoff.context(WatchSession.state))
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        guard state == .activated else { return }
        report()
        // A code sent while the app wasn't running.
        received(session.receivedApplicationContext)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        received(applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        received(message)
    }

    /// A code not tried yet, redeemed once: the same one comes as a message and in the context.
    private func received(_ m: [String: Any]) {
        guard let code = WatchHandoff.code(in: m, tried: Shared.defaults.string(forKey: "watch.triedCode")) else { return }
        Shared.defaults.set(code.code, forKey: "watch.triedCode")
        Task { @MainActor in await WatchModel.shared.redeem(code) }
    }
}
