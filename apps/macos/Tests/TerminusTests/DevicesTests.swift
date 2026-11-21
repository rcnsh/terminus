import Foundation
import Testing

@testable import Terminus

private func device(_ json: String) -> Device {
    try! JSONDecoder().decode(Device.self, from: Data(json.utf8))
}

@Test func aWatchIsNamedAWatch() {
    #expect(devicePlatformName(device(#"{"id":"a","platform":"ios","watch":true}"#)) == "Apple Watch")
    #expect(devicePlatformName(device(#"{"id":"b","platform":"ios","watch":false}"#)) == "iPhone")
    #expect(devicePlatformName(device(#"{"id":"c","platform":"ios"}"#)) == "iPhone")
    #expect(devicePlatformName(device(#"{"id":"d","platform":"mac"}"#)) == "Mac")
}

@Test func aWatchIsDrawnAsAWatch() {
    #expect(deviceSymbol(device(#"{"id":"a","platform":"ios","watch":true}"#)) == "applewatch")
    #expect(deviceSymbol(device(#"{"id":"c","platform":"ios"}"#)) == "iphone")
    #expect(deviceSymbol(device(#"{"id":"e","platform":"android"}"#)) == "iphone")
    #expect(deviceSymbol(device(#"{"id":"d","platform":"mac"}"#)) == "laptopcomputer")
}
