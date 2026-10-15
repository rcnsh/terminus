import Foundation

/// Apple's push service, as the server takes it at POST /api/me/push, one
/// token a request (DELETE clears both):
///
/// - `apns:<hex>`: this phone, for a nudge that the card changed
///   (`content-available`: the app fetches /me/next itself) and for alerts
///   (`mutable-content`: the notification service words them again from a
///   fresh /me/next).
/// - `apnsla:<hex>`: the running Live Activity's own token, so the server can
///   update and end it (`content-state` as TripAttributes.ContentState).
///   Sent again whenever a new one starts.
///
/// Each ends in `:sandbox` from a development (Debug) build: Apple's sandbox gateway.
extension Api {
    /// Whether this build's push tokens are for Apple's sandbox gateway: a debug build.
    static var apnsSandbox: Bool {
        #if DEBUG
            return true
        #else
            return false
        #endif
    }

    /// `prefix:` and the token in hex, with `:sandbox` for a development build.
    static func apnsToken(_ data: Data, prefix: String = "apns") -> String {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        return "\(prefix):\(hex)" + (apnsSandbox ? ":sandbox" : "")
    }

    /// One of this phone's push tokens: `apns:` or `apnsla:` (apnsToken).
    func registerPush(apple token: String) async throws {
        _ = try await send("POST", "/api/me/push", json: JSONSerialization.data(withJSONObject: ["token": token, "platform": "ios"]))
    }
}
