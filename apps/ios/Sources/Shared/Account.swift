import Foundation

/// `/api/me`: who this phone is signed in as.
struct Me: Decodable, Sendable {
    let email: String?
    let anonymous: Bool?
    /// Set while the account hasn't finished its setup.
    let onboarding: String?
    /// The timetable is for a semester that has ended.
    let needsReimport: Bool?
    let term: String?
}

struct SignInRequest: Decodable, Equatable, Sendable {
    let request: String
    let poll: String
    let match: Int
}

/// pending, approved (with a token, once), denied or expired; `outcome` as in applogin.ts.
struct SignInPoll: Decodable, Sendable {
    let status: String
    let token: String?
    let email: String?
    let outcome: String?
}

/// A device signed in to the account, as Settings lists it.
struct Device: Decodable, Identifiable, Hashable, Sendable {
    let id: String
    let name: String?
    let platform: String?
    let created: Double?
    let lastSeen: Double?
    let current: Bool?
}

/// A class you chose to leave a bus earlier for (`earlier`) or get no reminders for (`quiet`).
struct TripChoice: Decodable, Hashable, Sendable {
    let trip: String
    let pref: String
    let label: String?
}

struct Choices: Decodable, Sendable {
    let choices: [TripChoice]
    let history: Int?
}

/// An imported class whose room couldn't be placed: the person picks its stop, or skips it.
struct Unplaced: Hashable, Sendable {
    let module: String
    let venue: String
    let day: Int
    let arriveByMin: Int
    let endMin: Int?
    let offCampus: Bool
}

/// `/api/me/import`: what was found, what couldn't be placed, and for which semester.
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

    /// "Imported 12 classes for AY2026/27 Semester 1."
    var summary: String {
        classes == 1 ? L("Imported 1 class for %@.", term) : L("Imported %@ classes for %@.", "\(classes)", term)
    }

    /// The modules NUSMods had nothing for this semester, if any.
    var missingText: String? {
        missing.isEmpty ? nil : L("NUSMods has no classes this semester for %@.", missing.joined(separator: ", "))
    }
}

/// What the app asks for: the planned trip, a saved place, or any stop or venue.
enum Target: Hashable, Sendable {
    case plan
    case place(key: String)
    case code(String, label: String)
}
