import Foundation
import WatchConnectivity

final class PhoneLink: NSObject, WCSessionDelegate, @unchecked Sendable {
    static let shared = PhoneLink()

    func start() {
        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    func report() {
        let s = WCSession.default
        guard s.activationState == .activated else { return }
        try? s.updateApplicationContext(WatchHandoff.context(WatchSession.state))
    }

    func session(_ session: WCSession, activationDidCompleteWith state: WCSessionActivationState, error: Error?) {
        guard state == .activated else { return }
        report()
        received(session.receivedApplicationContext)
    }

    func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
        received(applicationContext)
    }

    func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        received(message)
    }

    private func received(_ m: [String: Any]) {
        guard let code = WatchHandoff.code(in: m, tried: Shared.defaults.string(forKey: "watch.triedCode")) else { return }
        Shared.defaults.set(code.code, forKey: "watch.triedCode")
        Task { @MainActor in await WatchModel.shared.redeem(code) }
    }
}
