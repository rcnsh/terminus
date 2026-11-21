import Foundation

struct Me: Decodable, Sendable {
    let email: String?
    let anonymous: Bool?
    let onboarding: String?
    let needsReimport: Bool?
    let term: String?
}

struct SignInRequest: Decodable, Equatable, Sendable {
    let request: String
    let poll: String
    let match: Int
}

struct SignInPoll: Decodable, Sendable {
    let status: String
    let token: String?
    let email: String?
    let outcome: String?
}

struct Device: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String?
    let platform: String?
    let watch: Bool?
    let created: Double?
    let lastSeen: Double?
    let current: Bool?
}

struct TripChoice: Decodable, Hashable, Sendable {
    let trip: String
    let pref: String
    let label: String?
}

struct Choices: Decodable, Sendable {
    let choices: [TripChoice]
    let history: Int?
}

struct Unplaced: Hashable, Sendable {
    let module: String
    let venue: String
    let day: Int
    let arriveByMin: Int
    let endMin: Int?
    let offCampus: Bool
}

struct ImportResult: @unchecked Sendable {
    let profile: [String: Any]
    let classes: Int
    let unplaced: [Unplaced]
    let missing: [String]
    let term: String

    init(_ o: [String: Any]) {
        profile = o["profile"] as? [String: Any] ?? [:]
        classes = (profile["trips"] as? [Any])?.count ?? 0
        unplaced = (o["unresolved"] as? [[String: Any]] ?? []).map {
            Unplaced(
                module: $0["module"] as? String ?? "", venue: $0["venue"] as? String ?? "", day: $0["day"] as? Int ?? 1,
                arriveByMin: $0["arriveByMin"] as? Int ?? 0, endMin: $0["endMin"] as? Int, offCampus: $0["offCampus"] as? Bool ?? false)
        }
        missing = o["missing"] as? [String] ?? []
        term = o["term"] as? String ?? ""
    }

    var summary: String {
        classes == 1 ? L("Imported 1 class for %@.", term) : L("Imported %@ classes for %@.", "\(classes)", term)
    }

    var missingText: String? {
        missing.isEmpty ? nil : L("NUSMods has no classes this semester for %@.", missing.joined(separator: ", "))
    }
}

enum Target: Hashable, Sendable {
    case plan
    case place(key: String)
    case code(String, label: String)
}
