import Foundation

/// Settings' requests, with the profile as JSON bytes: the bytes cross from
/// the main actor to the request and back, where a dictionary of `Any` can't.
extension Api {
    /// GET /api/me/profile as it came.
    func profileData() async throws -> Data {
        try await send("GET", "/api/me/profile")
    }

    /// PUT /api/me/profile: the whole profile; answers with it as saved.
    func saveProfileData(_ profile: Data) async throws -> Data {
        try await send("PUT", "/api/me/profile", json: profile)
    }
}
