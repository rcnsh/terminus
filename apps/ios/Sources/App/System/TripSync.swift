import Foundation

/// Keeps everything outside the app in step with the plan: the widgets, the
/// Live Activity and the leave reminder.
@MainActor enum TripSync {
    static func answered(_ answer: NextAnswer) {}
    static func signedIn() {}
    static func signedOut() {}
}
