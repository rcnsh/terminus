import Foundation
import Testing
@testable import Terminus

/// Crash reports: what goes to POST /api/errors, cut to size, and nothing else.

@Test func aReportCarriesOnlyTheFieldsTheServerTakes() throws {
    let r = CrashReport.make(version: "3.1.0", os: "macOS 26", type: "NSRangeException", message: "index 3 beyond bounds", stack: "a\nb", fatal: true)
    let json = try #require(JSONSerialization.jsonObject(with: JSONEncoder().encode(r)) as? [String: Any])
    #expect(Set(json.keys) == ["platform", "version", "os", "type", "message", "stack", "fatal"])
    #expect(json["platform"] as? String == "mac")
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
    #expect(CrashReport.make(version: "1", os: "macOS 26", type: "", message: "", stack: "", fatal: false).type == "Unknown")
}

@Test func crashTypesAreNamed() {
    #expect(CrashReport.crashType(exception: 1, signal: 11, objcName: nil) == "EXC_BAD_ACCESS / SIGSEGV")
    #expect(CrashReport.crashType(exception: 10, signal: 6, objcName: "NSInvalidArgumentException") == "NSInvalidArgumentException")
    #expect(CrashReport.crashType(exception: nil, signal: 5, objcName: "") == "SIGTRAP")
    #expect(CrashReport.crashType(exception: nil, signal: nil, objcName: nil) == "Unknown")
}

@Test func onlyTheMajorMacOSVersion() {
    #expect(CrashReport.osName(from: "macOS 26.0.1 (25A362)") == "macOS 26")
    #expect(CrashReport.osName(from: "") == nil)
    #expect(CrashReport.osName(major: 15) == "macOS 15")
}

@Test func aCallStackTreeIsOneFrameALineTheCrashedThreadFirst() {
    let json = """
    {"callStackPerThread":true,"callStacks":[
      {"threadAttributed":false,"callStackRootFrames":[{"binaryName":"libsystem_kernel.dylib","offsetIntoBinaryTextSegment":16,"address":4096}]},
      {"threadAttributed":true,"callStackRootFrames":[{"binaryName":"Terminus","offsetIntoBinaryTextSegment":6699,"address":4340000000,
        "subFrames":[{"binaryName":"AppKit","offsetIntoBinaryTextSegment":255,"address":8192}]}]}
    ]}
    """
    let text = CrashReport.frames(fromCallStackJSON: Data(json.utf8))
    #expect(text == "Terminus +0x1a2b (0x102af2500)\nAppKit +0xff (0x2000)\n--\nlibsystem_kernel.dylib +0x10 (0x1000)")
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
        store.add(.make(version: "3.1.0", os: "macOS 26", type: "T\(i)", message: "", stack: "", fatal: true))
        Thread.sleep(forTimeInterval: 0.002)
    }
    let pending = store.pending()
    #expect(pending.map(\.1.type) == ["T3", "T4", "T5", "T6", "T7"])
    store.remove(pending[0].0)
    #expect(store.pending().count == 4)
    store.removeAll()
    #expect(store.pending().isEmpty)
}
