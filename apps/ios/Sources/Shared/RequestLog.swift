import Foundation

enum RequestLog {
    struct Entry: Equatable, Sendable {
        let at: Date
        let method: String
        let path: String
        let host: String
        let status: Int?
        let tookMs: Int
        var failure: String? = nil
    }

    static let max = 50
    private static let list = Mutex<[Entry]>([])

    static func record(_ method: String, _ path: String, base: String, status: Int?, tookMs: Int, failure: Error?, at: Date = Date()) {
        let entry = Entry(
            at: at, method: method, path: pathOnly(path), host: URL(string: base)?.host ?? base, status: status, tookMs: tookMs,
            failure: failure.map(describe))
        list.withLock {
            $0.insert(entry, at: 0)
            if $0.count > max { $0.removeLast($0.count - max) }
        }
    }

    static var entries: [Entry] { list.withLock { $0 } }

    static func clear() { list.withLock { $0 = [] } }

    static func pathOnly(_ path: String) -> String {
        String(path.prefix { $0 != "?" && $0 != "#" })
    }

    static func describe(_ error: Error) -> String {
        if (error as? URLError)?.code == .cancelled || error is CancellationError { return "cancelled" }
        if let e = error as? URLError { return "URLError \(e.code.rawValue)" }
        return String(describing: type(of: error))
    }
}
