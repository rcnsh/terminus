import Foundation

/// Settings' requests, with the profile as JSON bytes: the bytes cross from
/// the main actor to the request and back, where a dictionary of `Any` can't.
extension Api {
    /// GET /api/me/profile as it came, with its version (the ETag).
    func profileData() async throws -> (Data, String?) {
        try await tagged("GET", "/api/me/profile")
    }

    /// PUT /api/me/profile: the whole profile; answers with it as saved and
    /// its new version. With `ifMatch`, a 412 if it changed since that version.
    func saveProfileData(_ profile: Data, ifMatch: String?) async throws -> (Data, String?) {
        try await tagged("PUT", "/api/me/profile", json: profile, ifMatch: ifMatch)
    }
}
