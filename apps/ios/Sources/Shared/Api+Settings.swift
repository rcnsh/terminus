import Foundation

extension Api {
    func profileData() async throws -> (Data, String?) {
        try await tagged("GET", "/api/me/profile")
    }

    func saveProfileData(_ profile: Data, ifMatch: String?) async throws -> (Data, String?) {
        try await tagged("PUT", "/api/me/profile", json: profile, ifMatch: ifMatch)
    }
}
