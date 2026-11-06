import Foundation
import Testing

@testable import Terminus

/// Crash reports: what goes to POST /api/errors, cut to size, and nothing else.

@Test func aReportCarriesOnlyTheFieldsTheServerTakes() throws {
    let r = CrashReport.make(
        version: "3.1.0", os: "iOS 26", type: "NSRangeException", message: "index 3 beyond bounds", stack: "a\nb", fatal: true)
    let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(r)) as? [String: Any])
    #expect(Set(json.keys) == ["platform", "version", "os", "type", "message", "stack", "fatal"])
    #expect(json["platform"] as? String == "ios")
    #expect(json["fatal"] as? Bool == true)
}

@Test func theStackIsCutToFortyLinesAndAFewKilobytes() {
    let long = (1...100).map { "frame \($0)" }.joined(separator: "\n")
    let lines = CrashReport.trimStack(long).split(separator: "\n")
    #expect(lines.count == 40)
    #expect(lines.last == "frame 40")
    let wide = String(repeating: "崩", count: 3_000)
    let cut = CrashReport.trimStack(wide)
    #expect(cut.utf8.count <= CrashReport.maxStackBytes)
    #expect(cut.allSatisfy { $0 == "崩" })
    #expect(CrashReport.make(version: "1", os: "iOS 26", type: "", message: "", stack: "", fatal: false).type == "Unknown")
}

@Test func crashTypesAreNamed() {
    #expect(CrashReport.crashType(exception: 1, signal: 11, objcName: nil) == "EXC_BAD_ACCESS / SIGSEGV")
    #expect(CrashReport.crashType(exception: 10, signal: 6, objcName: "NSInvalidArgumentException") == "NSInvalidArgumentException")
    #expect(CrashReport.crashType(exception: nil, signal: 5, objcName: "") == "SIGTRAP")
    #expect(CrashReport.crashType(exception: nil, signal: nil, objcName: nil) == "Unknown")
}

@Test func onlyTheMajorIOSVersion() {
    #expect(CrashReport.osName(from: "iPhone OS 26.0.1 (23A355)") == "iOS 26")
    #expect(CrashReport.osName(from: "") == nil)
    #expect(CrashReport.osName(major: 18) == "iOS 18")
}

@Test func aCallStackTreeIsOneFrameALineTheCrashedThreadFirst() {
    let json = """
        {"callStackPerThread":true,"callStacks":[
          {"threadAttributed":false,"callStackRootFrames":[{"binaryName":"libsystem_kernel.dylib","offsetIntoBinaryTextSegment":16,"address":4096}]},
          {"threadAttributed":true,"callStackRootFrames":[{"binaryName":"Terminus","offsetIntoBinaryTextSegment":6699,"address":4340000000,
            "subFrames":[{"binaryName":"UIKitCore","offsetIntoBinaryTextSegment":255,"address":8192}]}]}
        ]}
        """
    let text = CrashReport.frames(fromCallStackJSON: Data(json.utf8))
    #expect(text == "Terminus +0x1a2b (0x102af2500)\nUIKitCore +0xff (0x2000)\n--\nlibsystem_kernel.dylib +0x10 (0x1000)")
    #expect(CrashReport.frames(fromCallStackJSON: Data("not json".utf8)) == "not json")
}

@Test func anAnswerDropsTheReportNoAnswerKeepsIt() {
    #expect(CrashReporter.shouldDrop(status: 204))
    #expect(CrashReporter.shouldDrop(status: 400))
    #expect(CrashReporter.shouldDrop(status: 429))
    #expect(!CrashReporter.shouldDrop(status: 503))
    #expect(!CrashReporter.shouldDrop(status: nil))
}

@Test func atMostFiveWaitTheOldestDroppedFirst() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("crash-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = CrashReportStore(dir: dir)
    for i in 1...7 {
        store.add(.make(version: "3.1.0", os: "iOS 26", type: "T\(i)", message: "", stack: "", fatal: true))
        Thread.sleep(forTimeInterval: 0.002)
    }
    let pending = store.pending()
    #expect(pending.map(\.1.type) == ["T3", "T4", "T5", "T6", "T7"])
    store.remove(pending[0].0)
    #expect(store.pending().count == 4)
    store.removeAll()
    #expect(store.pending().isEmpty)
}

@Test func anExceptionsStackReadsLikeMetricKitsAndMarksItsCrash() throws {
    // The addresses of a real crash (NotificationDelegate, 3.8.0): Terminus loaded at 0x100214000.
    let images: [String: UInt] = ["Terminus": 0x1_0021_4000, "UIKitCore": 0x1_9375_0000]
    let image = { (a: UInt) in images.filter { a >= $0.value }.max { $0.value < $1.value }.map { (name: $0.key, base: $0.value) } }
    let stack = CrashReport.frames(addresses: [0x1_94ca_3468, 0x1_004a_ca94, 0x10], image: { $0 < 0x1_0000_0000 ? nil : image($0) })
    #expect(stack == "UIKitCore +0x1553468 (0x194ca3468)\nTerminus +0x298a94 (0x1004aca94)\n??? (0x10)")
    #expect(CrashReport.ownFrame(in: stack, app: "Terminus") == "(0x1004aca94)")
    #expect(CrashReport.ownFrame(in: stack, app: "Other") == nil)

    // The real stack names the binaries it ran through.
    let here = CrashReport.frames(addresses: Thread.callStackReturnAddresses.map(\.uintValue), image: CrashReport.image(of:))
    #expect(!here.isEmpty && !here.contains("???"))

    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("crash-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir) }
    let store = CrashReportStore(dir: dir)
    store.markException("(0x1004aca94)")
    let metricKit = "libsystem_kernel.dylib +0xb1fc (0x24b82a1fc)\nUIKitCore +0x1286cf4 (0x194cb0cf4)\nTerminus +0x298a94 (0x1004aca94)"
    #expect(!store.takeException(in: "Terminus +0x298a94 (0x2004aca94)"), "another launch's crash")
    #expect(store.takeException(in: metricKit), "the same crash, as MetricKit tells it")
    #expect(!store.takeException(in: metricKit), "once only")
    #expect(store.pending().isEmpty, "the marks aren't reports")
    store.markException("(0x1004aca94)")
    store.removeAll()
    #expect(!store.takeException(in: metricKit), "turned off, the marks go with the reports")
}
