import Foundation
import MetricKit

/// One crash or error, as the server takes it (POST /api/errors). It says
/// what broke and in which version, never who or where: no token, no device
/// or install id, no cookies, and no location.
struct CrashReport: Codable, Equatable, Sendable {
    var platform = "ios"
    var version: String
    var os: String
    var type: String
    var message: String
    var stack: String
    var fatal: Bool

    static let maxStackLines = 40
    static let maxStackBytes = 4_000
    static let maxMessageBytes = 1_000
    static let maxTypeBytes = 200

    /// A report with every field cut to what the server keeps.
    static func make(version: String, os: String, type: String, message: String, stack: String, fatal: Bool) -> CrashReport {
        CrashReport(
            version: cut(version, bytes: 40),
            os: cut(os, bytes: 40),
            type: cut(type.isEmpty ? "Unknown" : type, bytes: maxTypeBytes),
            message: cut(message, bytes: maxMessageBytes),
            stack: trimStack(stack),
            fatal: fatal
        )
    }

    /// The first [maxStackLines] lines, and no more than [maxStackBytes].
    static func trimStack(_ stack: String) -> String {
        let lines = stack.split(separator: "\n", omittingEmptySubsequences: true).prefix(maxStackLines)
        return cut(lines.joined(separator: "\n"), bytes: maxStackBytes)
    }

    /// [s] cut to at most [bytes] of UTF-8, never through a character.
    static func cut(_ s: String, bytes: Int) -> String {
        if s.utf8.count <= bytes { return s }
        var out = ""
        var used = 0
        for ch in s {
            let n = String(ch).utf8.count
            if used + n > bytes { break }
            out.append(ch)
            used += n
        }
        return out
    }

    /// "iOS 26": the major version only, which says enough and narrows no one down.
    static func osName(major: Int) -> String { "iOS \(major)" }

    /// MetricKit's "iPhone OS 26.0.1 (23A355)" as "iOS 26"; nil when there's no number in it.
    static func osName(from text: String) -> String? {
        guard let r = text.range(of: #"\d+"#, options: .regularExpression), let major = Int(text[r]) else { return nil }
        return osName(major: major)
    }

    /// "EXC_BAD_ACCESS / SIGSEGV"; an Objective-C exception's own name when there is one.
    static func crashType(exception: Int?, signal: Int?, objcName: String?) -> String {
        if let objcName, !objcName.isEmpty { return objcName }
        let parts = [exception.map(machName), signal.map(signalName)].compactMap { $0 }
        return parts.isEmpty ? "Unknown" : parts.joined(separator: " / ")
    }

    static func machName(_ n: Int) -> String {
        switch n {
        case 1: "EXC_BAD_ACCESS"
        case 2: "EXC_BAD_INSTRUCTION"
        case 3: "EXC_ARITHMETIC"
        case 4: "EXC_EMULATION"
        case 5: "EXC_SOFTWARE"
        case 6: "EXC_BREAKPOINT"
        case 10: "EXC_CRASH"
        case 11: "EXC_RESOURCE"
        case 12: "EXC_GUARD"
        default: "EXC_\(n)"
        }
    }

    static func signalName(_ n: Int) -> String {
        switch n {
        case 4: "SIGILL"
        case 5: "SIGTRAP"
        case 6: "SIGABRT"
        case 8: "SIGFPE"
        case 9: "SIGKILL"
        case 10: "SIGBUS"
        case 11: "SIGSEGV"
        case 13: "SIGPIPE"
        default: "SIG\(n)"
        }
    }

    /// A MetricKit call stack tree (its jsonRepresentation) as one frame a
    /// line, the crashed thread first: "Terminus +0x1a2b (0x10234a2b)".
    /// Binary names, offsets and addresses only; anything that doesn't parse
    /// is sent as it came, cut to size.
    static func frames(fromCallStackJSON data: Data) -> String {
        guard let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let stacks = root["callStacks"] as? [[String: Any]]
        else {
            return String(decoding: data, as: UTF8.self)
        }
        let ordered = stacks.filter { $0["threadAttributed"] as? Bool == true } + stacks.filter { $0["threadAttributed"] as? Bool != true }
        var lines: [String] = []
        func walk(_ frames: [[String: Any]]) {
            for f in frames where lines.count < maxStackLines {
                lines.append(
                    frameLine(
                        f["binaryName"] as? String ?? "???",
                        offset: (f["offsetIntoBinaryTextSegment"] as? NSNumber)?.uint64Value,
                        address: (f["address"] as? NSNumber)?.uint64Value
                    ))
                if let sub = f["subFrames"] as? [[String: Any]] { walk(sub) }
            }
        }
        for (i, stack) in ordered.enumerated() where lines.count < maxStackLines {
            if i > 0 { lines.append("--") }
            walk(stack["callStackRootFrames"] as? [[String: Any]] ?? [])
        }
        return lines.joined(separator: "\n")
    }

    /// An exception's return addresses in the same form as a MetricKit
    /// stack, so the two read and symbolicate alike. [image] names the
    /// binary an address is in and where that binary starts.
    static func frames(addresses: [UInt], image: (UInt) -> (name: String, base: UInt)?) -> String {
        addresses.prefix(maxStackLines).map { a in
            guard let i = image(a), a >= i.base else { return frameLine("???", offset: nil, address: UInt64(a)) }
            return frameLine(i.name, offset: UInt64(a - i.base), address: UInt64(a))
        }.joined(separator: "\n")
    }

    /// "Terminus +0x1a2b (0x10234a2b)": one frame, the same from MetricKit or an exception, so takeException can match them.
    static func frameLine(_ binary: String, offset: UInt64?, address: UInt64?) -> String {
        var line = binary
        if let offset { line += " +0x" + String(offset, radix: 16) }
        if let address { line += " (0x" + String(address, radix: 16) + ")" }
        return line
    }

    /// The binary holding [address] and where it starts, from dyld.
    static func image(of address: UInt) -> (name: String, base: UInt)? {
        var info = Dl_info()
        guard dladdr(UnsafeRawPointer(bitPattern: address), &info) != 0, let path = info.dli_fname, let base = info.dli_fbase else {
            return nil
        }
        return ((String(cString: path) as NSString).lastPathComponent, UInt(bitPattern: base))
    }

    /// The address of the stack's first frame in [app], as "(0x1004aca94)".
    /// MetricKit's later report of the same crash holds it too; another
    /// crash's doesn't, since the app loads at a new address each launch.
    static func ownFrame(in stack: String, app: String) -> String? {
        guard let line = stack.split(separator: "\n").first(where: { $0.hasPrefix(app + " +0x") }),
            let open = line.range(of: " (0x")
        else { return nil }
        return String(line[line.index(after: open.lowerBound)...])
    }
}

/// Reports waiting to be sent: one small JSON file each, at most [limit],
/// the oldest dropped first.
struct CrashReportStore: Sendable {
    let dir: URL
    var limit = 5

    /// The app's own Library/Application Support/CrashReports.
    static var standard: CrashReportStore {
        let base =
            FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory
        return CrashReportStore(dir: base.appendingPathComponent("CrashReports"))
    }

    func add(_ report: CrashReport) {
        guard let data = try? JSONEncoder().encode(report) else { return }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Named by time, so the oldest sorts first.
        let name = String(format: "%.0f-%@.json", Date().timeIntervalSince1970 * 1000, UUID().uuidString.prefix(8) as CVarArg)
        try? data.write(to: dir.appendingPathComponent(name), options: .atomic)
        prune()
    }

    /// The waiting reports, oldest first.
    func pending() -> [(URL, CrashReport)] {
        files().compactMap { url in
            guard let data = try? Data(contentsOf: url), let r = try? JSONDecoder().decode(CrashReport.self, from: data) else {
                try? FileManager.default.removeItem(at: url)
                return nil
            }
            return (url, r)
        }
    }

    func remove(_ url: URL) { try? FileManager.default.removeItem(at: url) }

    /// The last few exceptions' own frames (ownFrame), one a line.
    private var exceptionsFile: URL { dir.appendingPathComponent("exceptions.txt") }

    /// Remembers an exception's frame, so MetricKit's report of the same crash can be told apart.
    func markException(_ frame: String) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        write(marks: marks().suffix(max(0, limit - 1)) + [frame])
    }

    /// Whether [stack] is a crash already reported as its exception, forgetting the mark if so.
    func takeException(in stack: String) -> Bool {
        var marks = marks()
        guard let hit = marks.firstIndex(where: { stack.contains($0) }) else { return false }
        marks.remove(at: hit)
        write(marks: marks)
        return true
    }

    private func marks() -> [String] {
        ((try? String(contentsOf: exceptionsFile, encoding: .utf8)) ?? "").split(separator: "\n").map(String.init)
    }

    private func write(marks: [String]) {
        try? marks.joined(separator: "\n").write(to: exceptionsFile, atomically: true, encoding: .utf8)
    }

    /// Every waiting report, and the exceptions' marks with them.
    func removeAll() {
        files().forEach(remove)
        remove(exceptionsFile)
    }

    private func files() -> [URL] {
        let all = (try? FileManager.default.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil)) ?? []
        return all.filter { $0.pathExtension == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
    }

    private func prune() {
        let all = files()
        all.prefix(max(0, all.count - limit)).forEach(remove)
    }
}

/// Crash reporting: MetricKit's crash diagnostics (delivered on a later
/// launch) and uncaught Objective-C exceptions (written to disk as the app
/// dies, sent on the next launch). Nothing is kept or sent with "Send crash
/// reports" off.
final class CrashReporter: NSObject, MXMetricManagerSubscriber, @unchecked Sendable {
    static let shared = CrashReporter()
    static let key = "sendCrashReports"

    /// On unless turned off in Settings.
    static var enabled: Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }

    /// Where the exception handler writes; a static, since the handler is a C function and can't capture.
    nonisolated(unsafe) private static var store = CrashReportStore.standard

    private static var version: String { Api.version }
    private static var os: String { CrashReport.osName(major: ProcessInfo.processInfo.operatingSystemVersion.majorVersion) }

    /// Called once at launch.
    func start() {
        MXMetricManager.shared.add(self)
        NSSetUncaughtExceptionHandler { e in
            // The app is going down: write the file and nothing else, no network.
            guard CrashReporter.enabled else { return }
            let stack = CrashReport.frames(addresses: e.callStackReturnAddresses.map(\.uintValue), image: CrashReport.image(of:))
            CrashReporter.store.add(
                .make(
                    version: CrashReporter.version, os: CrashReporter.os,
                    type: e.name.rawValue, message: e.reason ?? "", stack: stack, fatal: true
                ))
            if let app = Bundle.main.executableURL?.lastPathComponent, let frame = CrashReport.ownFrame(in: stack, app: app) {
                CrashReporter.store.markException(frame)
            }
        }
        Task.detached(priority: .utility) { await Self.sendPending() }
    }

    // MARK: MXMetricManagerSubscriber

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        guard Self.enabled else { return }
        for payload in payloads {
            for crash in payload.crashDiagnostics ?? [] {
                // An uncaught exception ends the app with SIGABRT, which MetricKit
                // reports too: one crash, already kept with its exception's name.
                let report = Self.report(crash)
                if !Self.store.takeException(in: report.stack) { Self.store.add(report) }
            }
        }
        Task.detached(priority: .utility) { await Self.sendPending() }
    }

    private static func report(_ d: MXCrashDiagnostic) -> CrashReport {
        let objc = d.exceptionReason
        let message = objc?.composedMessage ?? d.terminationReason ?? ""
        return .make(
            version: version,
            os: CrashReport.osName(from: d.metaData.osVersion) ?? os,
            type: CrashReport.crashType(exception: d.exceptionType?.intValue, signal: d.signal?.intValue, objcName: objc?.exceptionName),
            message: message,
            stack: CrashReport.frames(fromCallStackJSON: d.callStackTree.jsonRepresentation()),
            fatal: true
        )
    }

    // MARK: Sending

    /// No cookies, no cache, nothing remembered between requests.
    private static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCache = nil
        c.timeoutIntervalForRequest = 20
        return URLSession(configuration: c)
    }()

    /// What to do with a report after a send: drop it on any answer the
    /// server gave (2xx sent, 4xx refused or rate limited), keep it for the
    /// next launch on a 5xx or no answer.
    static func shouldDrop(status: Int?) -> Bool {
        guard let status else { return false }
        return (200..<500).contains(status)
    }

    /// Sends what's waiting to the server the app uses (Servers), one at a
    /// time. Turned off, the waiting reports are deleted instead.
    static func sendPending() async {
        guard enabled else {
            store.removeAll()
            return
        }
        for (file, report) in store.pending() {
            let body = try? JSONEncoder().encode(report)
            // The chosen address, then the site's other one if it can't be reached (Servers.reach).
            let sent = try? await Servers.reach(method: "POST") { base in
                guard let url = URL(string: base + "/api/errors") else { throw URLError(.badURL) }
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.httpBody = body
                return try await session.data(for: req)
            }
            let status = sent.flatMap { ($0.1 as? HTTPURLResponse)?.statusCode }
            if shouldDrop(status: status) { store.remove(file) } else if status == nil { return }
        }
    }
}
