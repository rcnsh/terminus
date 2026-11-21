import Foundation

extension Api {
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

    static func apsEnvironment(profile: Data) -> String? {
        guard let text = String(data: profile, encoding: .isoLatin1),
            let start = text.range(of: "<?xml"), let end = text.range(of: "</plist>", range: start.lowerBound..<text.endIndex),
            let plist = try? PropertyListSerialization.propertyList(from: Data(text[start.lowerBound..<end.upperBound].utf8), format: nil)
                as? [String: Any],
            let ent = plist["Entitlements"] as? [String: Any]
        else { return nil }
        return ent["aps-environment"] as? String
    }

    static func apnsToken(_ data: Data, prefix: String = "apns") -> String {
        let hex = data.map { String(format: "%02x", $0) }.joined()
        return "\(prefix):\(hex)" + (apnsSandbox ? ":sandbox" : "")
    }

    func registerPush(apple token: String, alerts: Bool? = nil, live: Bool? = nil, activity: Bool? = nil, h12: Bool? = nil) async throws {
        var body: [String: Any] = ["token": token, "platform": "ios"]
        if let alerts { body["alerts"] = alerts }
        if let live { body["live"] = live }
        if let activity { body["activity"] = activity }
        if let h12 { body["h12"] = h12 }
        _ = try await send("POST", "/api/me/push", json: JSONSerialization.data(withJSONObject: body))
    }
}
