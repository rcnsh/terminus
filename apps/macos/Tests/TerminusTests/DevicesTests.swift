import Foundation
import Testing

@testable import Terminus

private func device(_ json: String) -> Device {
    try! JSONDecoder().decode(Device.self, from: Data(json.utf8))
}

/// The devices list names a watch from the server's `watch`, not its
/// platform (which is "ios", as for an iPhone).
@Test func aWatchIsNamedAWatch() {
    #expect(devicePlatformName(device(#"{"id":"a","platform":"ios","watch":true}"#)) == "Apple Watch")
    #expect(devicePlatformName(device(#"{"id":"b","platform":"ios","watch":false}"#)) == "iPhone")
    // An older server sends no `watch`.
    #expect(devicePlatformName(device(#"{"id":"c","platform":"ios"}"#)) == "iPhone")
    #expect(devicePlatformName(device(#"{"id":"d","platform":"mac"}"#)) == "Mac")
}
