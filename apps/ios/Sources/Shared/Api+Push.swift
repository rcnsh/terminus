import Foundation

/// Apple's push service, as the server takes it at POST /api/me/push, one
/// token a request (DELETE clears them all):
///
/// - `apns:<hex>`: this phone, for a nudge that the card changed
///   (`content-available`: the app fetches /me/next itself) and for alerts
///   (`mutable-content`: the notification service words them again from a
///   fresh /me/next). Sent with `alerts`, the leave alerts switch: off, the
///   trip comes only as the nudge, never an alert; and `live`, the Live
///   Activity switch: off, the server forgets the `apnsstart:` token.
/// - `apnsla:<hex>`: the running Live Activity's own token, so the server can
///   update and end it (`content-state` as TripAttributes.ContentState).
///   Sent again whenever a new one starts.
/// - `apnsstart:<hex>`: the token that starts a Live Activity by push (iOS
///   17.2 and later), so the server can start one when the trip is due or
///   missed with the app closed, as Android's live notification starts.
///   Sent only while the Live Activity is on.
///
/// Each ends in `:sandbox` when the build's provisioning profile says
/// `aps-environment: development`: Apple's sandbox gateway. Xcode signs a
/// Release build run from it that way too; an App Store or TestFlight build
/// has no profile inside and is production.
extension Api {
    /// Whether this build's push tokens are for Apple's sandbox gateway.
    static let apnsSandbox: Bool = {
        #if targetEnvironment(simulator)
            return true
        #else
            guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
                let data = try? Data(contentsOf: url)
            else { return false }
            return apsEnvironment(profile: data) == "development"
        #endif
    }()

    /// The `aps-environment` a provisioning profile grants, read from the
    /// plist inside its signature; nil without one.
    static func apsEnvironment(profile: Data) -> String? {
        guard let text = String(data: profile, encoding: .isoLatin1),
            let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>", range: start.lowerBound..<text.endIndex),
            let plist = try? PropertyListSerialization.propertyList(from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil)
                as? [String: Any],
            let ent = plist["Entitlements"] as? [String: Any]
        else { return nil }
        return ent["aps-environment"] as? String
    }

    /// `prefix:` and the token in hex, with `:sandbox` for a development build.
    static func apnsToken(_ data: Data, prefix: String = "apns") -> String {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        return "\(prefix):\(hex)" + (apnsSandbox ? ":sandbox" : "")
    }

    /// One of this phone's push tokens: `apns:`, `apnsla:` or `apnsstart:`
    /// (apnsToken). With the phone's, whether its leave alerts are on (off,
    /// the server pushes the trip to it only silently, as Android shows
    /// nothing then) and whether its Live Activity is (off, none is started by push).
    func registerPush(apple token: String, alerts: Bool? = nil, live: Bool? = nil) async throws {
        var body: [String: Any] = ["token": token, "platform": "ios"]
        if let alerts { body["alerts"] = alerts }
        if let live { body["live"] = live }
        _ = try await send("POST", "/api/me/push", json: JSONSerialization.data(withJSONObject: body))
    }
}
