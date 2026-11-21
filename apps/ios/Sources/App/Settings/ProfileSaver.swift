import Foundation
import Observation

struct ProfileWire: Sendable {
    var fetch: @Sendable (String) async throws -> (Data, String?)
    var save: @Sendable (String, Data, String?) async throws -> (Data, String?)

    static let api = ProfileWire(
        fetch: { try await Api(token: $0).profileData() },
        save: { try await Api(token: $0).saveProfileData($1, ifMatch: $2) })
}

@MainActor @Observable
final class ProfileSaver {
    private(set) var doc: ProfileDoc?

    @ObservationIgnored var token: () -> String? = { AppModel.shared.token }
    @ObservationIgnored var held: () -> Bool = { false }
    @ObservationIgnored var onSaved: (_ saved: ProfileDoc, _ before: ProfileDoc?) -> Void = { _, _ in }
    @ObservationIgnored var onRejected: (_ token: String) -> Void = { _ in }
    @ObservationIgnored var say: (String) -> Void = { _ in }

    @ObservationIgnored private let wire: ProfileWire
    @ObservationIgnored private let wait: Duration
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var sending: Task<Void, Never>?
    @ObservationIgnored private var confirmed: ProfileDoc?
    @ObservationIgnored private var version: String?
    @ObservationIgnored private var pending: [(inout ProfileDoc) -> Void] = []
    @ObservationIgnored private var epoch = 0

    init(wire: ProfileWire = .api, wait: Duration = .milliseconds(400)) {
        self.wire = wire
        self.wait = wait
    }

    static let tries = 3

    var saving: Bool { saveTask != nil || sending != nil || !pending.isEmpty }

    @discardableResult
    func loaded(_ p: ProfileDoc, tag: String?) -> Bool {
        guard !saving else { return false }
        doc = p
        version = tag
        return true
    }

    func adopt(_ saved: ProfileDoc) {
        confirmed = saved
        var shown = saved
        for change in pending { change(&shown) }
        doc = shown
        resume()
    }

    func edit(_ change: @escaping (inout ProfileDoc) -> Void) {
        guard var next = doc, token() != nil else { return }
        if !saving { confirmed = doc }
        change(&next)
        pending.append(change)
        doc = next
        saveTask?.cancel()
        saveTask = Task {
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled else { return }
            saveTask = nil
            send()
        }
    }

    func resume() {
        if saveTask == nil { send() }
    }

    func sendNow() {
        guard saveTask != nil else { return }
        saveTask?.cancel()
        saveTask = nil
        send()
    }

    func flush() async {
        sendNow()
        let mine = epoch
        while let s = sending, mine == epoch { await s.value }
    }

    func reset() {
        saveTask?.cancel()
        saveTask = nil
        sending = nil
        epoch += 1
        doc = nil
        confirmed = nil
        version = nil
        pending = []
    }

    private func current(_ mine: Int, _ token: String) -> Bool { mine == epoch && self.token() == token }

    private func dropped(_ mine: Int) {
        if mine == epoch { sending = nil }
    }

    private func send() {
        guard sending == nil, !held(), !pending.isEmpty, let token = token(), let base = confirmed else { return }
        let changes = pending
        pending = []
        var body = base
        for change in changes { change(&body) }
        let from = version
        let mine = epoch
        let wire = wire
        sending = Task {
            do {
                var (data, tag): (Data, String?)
                var (put, match) = (body, from)
                var tries = 0
                while true {
                    tries += 1
                    do {
                        (data, tag) = try await wire.save(token, put.data, match)
                        break
                    } catch let e as ApiError where e.status == 412 && tries < Self.tries {
                        let (fresh, freshTag) = try await wire.fetch(token)
                        guard current(mine, token) else { return dropped(mine) }
                        guard var latest = ProfileDoc(data: fresh) else { throw URLError(.cannotParseResponse) }
                        for change in changes { change(&latest) }
                        if latest.missed { say(L("A class was changed on another device. Check it and try again.")) }
                        (put, match) = (latest, freshTag)
                    }
                }
                guard current(mine, token) else { return dropped(mine) }
                sending = nil
                guard let saved = ProfileDoc(data: data) else { return }
                version = tag
                let before = confirmed
                confirmed = saved
                var shown = saved
                for change in pending { change(&shown) }
                doc = shown
                onSaved(saved, before)
                resume()
            } catch {
                guard current(mine, token) else { return dropped(mine) }
                sending = nil
                saveTask?.cancel()
                saveTask = nil
                pending = []
                if let e = error as? ApiError, e.status == 401 {
                    onRejected(token)
                    return
                }
                if let confirmed { doc = confirmed }
                say(L("Not saved: %@", failureMessage(error)))
            }
        }
    }
}
