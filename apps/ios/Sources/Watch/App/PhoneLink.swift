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
    }

    func session(_ session: WCSession, didReceiveUserInfo userInfo: [String: Any] = [:]) {
        guard let code = WatchHandoff.code(in: userInfo) else { return }
        Task { @MainActor in await WatchModel.shared.redeem(code) }
    }
}
