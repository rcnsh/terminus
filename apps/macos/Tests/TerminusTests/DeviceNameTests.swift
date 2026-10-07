import Testing
@testable import Terminus

/// An anonymous Mac reports its model, never the name its owner gave it.
@Test func theDeviceNameIsTheModel() {
    #expect(macModelName(productName: "MacBook Pro (16-inch, M5 Pro)", hwModel: "Mac17,8") == "MacBook Pro (16-inch, M5 Pro)")
    #expect(macModelName(productName: nil, hwModel: "MacBookAir7,2") == "MacBook Air")
    #expect(macModelName(productName: nil, hwModel: "MacBookPro16,1") == "MacBook Pro")
    #expect(macModelName(productName: nil, hwModel: "iMacPro1,1") == "iMac Pro")
    #expect(macModelName(productName: nil, hwModel: "iMac20,1") == "iMac")
    #expect(macModelName(productName: nil, hwModel: "Macmini9,1") == "Mac mini")
    #expect(macModelName(productName: " ", hwModel: "Mac14,2") == "Mac")
    #expect(macModelName(productName: nil, hwModel: nil) == "Mac")
    #expect(macModelName(productName: String(repeating: "x", count: 60), hwModel: nil).count == 40)
}
