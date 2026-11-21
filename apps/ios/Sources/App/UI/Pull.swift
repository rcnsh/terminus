import CoreGraphics
import Foundation

enum PullOutcome: Equatable {
    case updated
    case upToDate(nextInS: Int?)
    case failed

    var words: String {
        switch self {
        case .updated: L("Updated just now")
        case .upToDate(let s?): L("Up to date, next update in %@ s", "\(s)")
        case .upToDate(nil): L("Up to date")
        case .failed: L("Couldn't update")
        }
    }

    var good: Bool { self != .failed }
}

enum PullHint: Equatable {
    case pull, letGo, checking
    case done(PullOutcome)

    var words: String {
        switch self {
        case .pull: L("Pull to refresh")
        case .letGo: L("Let go to refresh")
        case .checking: L("Checking…")
        case .done(let o): o.words
        }
    }
}

enum Pull {
    static let arm: CGFloat = 84
    static let hold: CGFloat = 40
    static let max: CGFloat = 170
    private static let soft: CGFloat = 200
    static let leadShare: CGFloat = 0.12

    static let freshS: TimeInterval = 15
    static let minShowMs: CGFloat = 700
    static let quickMs: CGFloat = 600
    static let resultMs: CGFloat = 1_000

    static let start: CGFloat = -60
    static let shortOfSign: CGFloat = 44

    static func rubber(_ raw: CGFloat) -> CGFloat { max * (1 - exp(-Swift.max(raw, 0) / soft)) }

    static func unrubber(_ pull: CGFloat) -> CGFloat { -soft * log(1 - Swift.min(Swift.max(pull, 0), max - 0.01) / max) }

    static func lead(_ pull: CGFloat) -> CGFloat { pull * leadShare }

    static func shouldFetch(lastOK: Date?, now: Date) -> Bool {
        guard let lastOK else { return true }
        let age = now.timeIntervalSince(lastOK)
        return age < 0 || age >= freshS
    }

    static func inS(_ at: Date?, now: Date) -> Int? {
        guard let at, at > now else { return nil }
        return Swift.max(1, Int(ceil(at.timeIntervalSince(now))))
    }

    static func minShow(_ o: PullOutcome) -> CGFloat {
        if case .upToDate = o { return quickMs }
        return minShowMs
    }

    static func progress(_ pull: CGFloat) -> CGFloat { Swift.min(Swift.max(pull / arm, 0), 1) }

    static func armed(_ pull: CGFloat) -> Bool { pull >= arm }

    static func busX(_ progress: CGFloat, start: CGFloat, stop: CGFloat) -> CGFloat {
        start + (stop - start) * (1 - pow(1 - Swift.min(Swift.max(progress, 0), 1), 1.6))
    }

    static func hintAlpha(_ pull: CGFloat, held: Bool) -> CGFloat { held ? 1 : Swift.min(Swift.max((pull - 22) / 22, 0), 1) }

    static func signGrow(_ pull: CGFloat, held: Bool) -> CGFloat { held ? 1 : Swift.min(Swift.max((pull - 6) / 34, 0), 1) }

    static func pillCentre(above: CGFloat, room: CGFloat, pull: CGFloat) -> CGFloat { (lead(pull) - above + room) / 2 }

    static func spring(_ x: CGFloat, _ v: CGFloat, target: CGFloat, k: CGFloat, c: CGFloat, dt: CGFloat) -> (CGFloat, CGFloat) {
        let nv = v + (k * (target - x) - c * v) * dt
        return (x + nv * dt, nv)
    }

    static func roadBus(_ sign: CGFloat, _ far: CGFloat) -> CGFloat { roadBusX(sign, far) }

    static func hillSign(_ w: CGFloat) -> CGFloat { (w * 0.68).rounded() }
}

struct PullScene: Equatable {
    var width: CGFloat
    var sign: CGFloat
    var home: CGFloat?

    var stop: CGFloat { sign - Pull.shortOfSign }
    var from: CGFloat { home ?? Pull.start }
    var rest: CGFloat { home ?? stop }

    static func road(_ width: CGFloat, _ road: Road) -> PullScene {
        let sign = roadSign(width)
        let card = road.stop ? road.bus : nil
        return PullScene(width: width, sign: sign, home: card.map { Pull.roadBus(sign, $0.far) } ?? (road.shuttle ? shuttleX(width) : nil))
    }

    static func hill(_ width: CGFloat) -> PullScene { PullScene(width: width, sign: Pull.hillSign(width)) }
}

struct Puff: Equatable {
    var x: CGFloat
    var age: CGFloat = 0
}

struct PullFrame: Equatable {
    var open = false, lit = false, good = false, calm = false
    var driving = false
    var signGrow: CGFloat = 0, clock: CGFloat = 0
    var busX: CGFloat = 0, alpha: CGFloat = 1, bob: CGFloat = 0, tilt: CGFloat = 0, wheel: CGFloat = 0
    var door: CGFloat = 0, honk: CGFloat = 0
    var puffs: [Puff] = []
}

final class PullMotion {
    enum Phase {
        case idle, drag
        case cancel
        case busy
        case shown
        case closing
    }

    enum Drive { case follow, boarding, departing, looping, back }

    var scene: PullScene
    var calm: Bool

    private(set) var phase = Phase.idle
    private(set) var drive = Drive.follow

    private(set) var pull: CGFloat = 0
    private var pullV: CGFloat = 0
    private var raw: CGFloat = 0
    private(set) var armed = false

    private(set) var sinceMs: CGFloat = 0
    private var driveMs: CGFloat = 0
    private var shownMs: CGFloat = 0
    private var outcome: PullOutcome?

    private(set) var result: PullOutcome?

    private(set) var busX: CGFloat
    private var busV: CGFloat = 0
    private var lastX: CGFloat
    private var smV: CGFloat = 0
    private var smA: CGFloat = 0
    private(set) var tilt: CGFloat = 0
    private var tiltV: CGFloat = 0
    private(set) var kneel: CGFloat = 0
    private var kneelV: CGFloat = 0
    private(set) var wheel: CGFloat = 0
    private var dist: CGFloat = 0
    private var t: CGFloat = 0

    private(set) var door: CGFloat = 0
    private(set) var honk: CGFloat = 0

    private(set) var alpha: CGFloat = 1
    private(set) var puffs: [Puff] = []
    private var puffEvery: CGFloat = 0

    init(scene: PullScene, calm: Bool = false) {
        self.scene = scene
        self.calm = calm
        busX = scene.from
        lastX = scene.from
    }

    var frame: PullFrame {
        PullFrame(
            open: open, lit: lit, good: good, calm: calm, driving: drive != .follow, signGrow: signGrow, clock: clock, busX: busX,
            alpha: alpha, bob: bob, tilt: tilt, wheel: wheel, door: door, honk: honk, puffs: puffs)
    }

    var moving: Bool { phase != .idle || !puffs.isEmpty }

    var open: Bool { phase != .idle }

    var held: Bool { phase == .busy || phase == .shown }

    var hint: PullHint? {
        switch phase {
        case .idle: nil
        case .drag, .cancel: armed ? .letGo : .pull
        case .busy: .checking
        case .shown, .closing: result.map { .done($0) } ?? .pull
        }
    }

    var hintAlpha: CGFloat { Pull.hintAlpha(pull, held: held) }

    var signGrow: CGFloat { Pull.signGrow(pull, held: held) }

    var lead: CGFloat { Pull.lead(pull) }

    var lit: Bool { armed || phase == .busy }

    var good: Bool { (phase == .shown || (phase == .closing && pull > 0)) && result?.good == true }

    var bob: CGFloat { calm ? 0 : kneel + 0.25 * sin(dist / 5) * Swift.min(Swift.max(abs(smV) / 200, 0), 1) }

    var clock: CGFloat { t }

    var canGrab: Bool { phase == .idle || phase == .cancel }

    private var scrolled = false

    func touch() { scrolled = false }

    func contentScrolled() {
        if phase != .drag { scrolled = true }
    }

    @discardableResult
    func drag(_ dy: CGFloat) -> Bool {
        if phase != .drag && (!canGrab || scrolled) { return false }
        if phase != .drag {
            if phase == .idle {
                busX = scene.from
                lastX = busX
            }
            phase = .drag
            drive = .follow
            raw = Pull.unrubber(pull)
            result = nil
        }
        raw = Swift.max(raw + dy, 0)
        pull = Pull.rubber(raw)
        pullV = 0
        let was = armed
        armed = Pull.armed(pull)
        if armed && !was && !calm { kneelV += 14 }
        if raw == 0 { rest() }
        return armed && !was
    }

    func takeBack(_ dy: CGFloat) -> CGFloat {
        guard phase == .drag, dy < 0 else { return 0 }
        let used = Swift.max(dy, -raw)
        drag(used)
        return used
    }

    func release() -> Bool {
        guard phase == .drag else { return false }
        let go = armed
        armed = false
        sinceMs = 0
        if go {
            phase = .busy
            drive = .boarding
            driveMs = 0
            outcome = nil
            busV = 0
            if !calm { busX = scene.stop }
        } else {
            phase = pull > 0 ? .cancel : .idle
        }
        return go
    }

    func done(_ o: PullOutcome) {
        if phase == .busy { outcome = o }
    }

    func step(_ dtIn: CGFloat) {
        let dt = Swift.min(Swift.max(dtIn, 0), 0.05)
        t += dt
        sinceMs += dt * 1000
        driveMs += dt * 1000

        if phase == .busy, let o = outcome, sinceMs >= Pull.minShow(o) { show(o) }
        if phase == .shown {
            shownMs += dt * 1000
            if shownMs >= Pull.resultMs { phase = .closing }
        }

        if phase != .drag && phase != .idle {
            let target = held ? Pull.hold : 0
            if calm {
                pull += (target - pull) * (1 - exp(-dt * 14))
                pullV = 0
            } else {
                (pull, pullV) =
                    phase == .closing
                    ? Pull.spring(pull, pullV, target: target, k: 240, c: 31, dt: dt)
                    : Pull.spring(pull, pullV, target: target, k: 190, c: 26, dt: dt)
            }
            if (phase == .cancel || phase == .closing) && pull < 0.4 && abs(pullV) < 5 {
                pull = 0
                pullV = 0
                if phase == .cancel || busHome { rest() }
            }
        }

        door = 0
        honk = 0
        if calm { stepCalm() } else { stepDriving(dt) }
        for i in puffs.indices { puffs[i].age += dt }
        puffs.removeAll { $0.age >= 0.6 }
    }

    private var busHome: Bool {
        calm || scene.home == nil || (drive == .back && abs(busX - scene.rest) < 1)
    }

    private func show(_ o: PullOutcome) {
        phase = .shown
        result = o
        shownMs = 0
        if drive == .boarding { depart() }
    }

    private func depart() {
        drive = .departing
        driveMs = 0
        busV = 30
    }

    private func stepCalm() {
        let home = scene.home
        busX = home ?? scene.stop
        tilt = 0
        kneel = 0
        alpha =
            if home != nil { 1 } else if phase == .idle { 0 } else if held { 1 } else {
                Swift.min(Swift.max((pull - 10) / (Pull.arm - 10), 0), 1)
            }
        door = phase == .busy && home == nil ? 1 : 0
    }

    private func stepDriving(_ dt: CGFloat) {
        alpha = scene.home == nil && (phase == .closing || phase == .cancel) && drive != .follow ? signGrow : 1
        if drive == .follow {
            busX = Pull.busX(Pull.progress(pull), start: scene.from, stop: scene.stop)
        } else {
            driveOn(dt)
        }
        let step = Swift.max(dt, 1 / 240)
        let v = (busX - lastX) / step
        lastX = busX
        let a = (v - smV) / step
        smV += (v - smV) * 0.35
        smA += (a - smA) * 0.2
        (tilt, tiltV) = Pull.spring(tilt, tiltV, target: Swift.min(Swift.max(-smA * 0.004, -4.5), 4.5), k: 160, c: 9, dt: dt)
        let kneeling = armed || drive == .boarding
        (kneel, kneelV) = Pull.spring(kneel, kneelV, target: kneeling ? 0.55 : 0, k: 140, c: 10, dt: dt)
        dist += abs(v * dt)
        wheel += v * dt / 2.2
        if drive == .departing || (drive == .looping && busX < 30) {
            puffEvery -= dt
            if puffEvery <= 0 {
                puffEvery = 0.07
                puffs.append(Puff(x: busX - 2))
            }
        }
    }

    private func driveOn(_ dt: CGFloat) {
        switch drive {
        case .follow: break
        case .boarding:
            busX = scene.stop
            let s = driveMs
            door = (s > 60 && s < 190) || (s > 300 && s < 430) ? 1 : 0
            honk = s > 140 && s < 560 ? sin((s - 140) / 420 * .pi) : 0
            if s > 620 { depart() }
        case .departing:
            busV += 560 * dt
            busX += busV * dt
            if busX > scene.width + 30 { lap(cruise: 240) }
        case .looping:
            busX += busV * dt
            if busX > scene.width + 30 { lap(cruise: busV) }
        case .back:
            let to = scene.rest
            busX += (to - busX) * (1 - exp(-dt * 6))
            if abs(busX - to) < 0.05 { busX = to }
        }
    }

    private func lap(cruise: CGFloat) {
        busX = Pull.start - 10
        lastX = busX
        if phase == .busy {
            drive = .looping
            busV = cruise
        } else {
            drive = .back
            busV = 0
        }
    }

    private func rest() {
        phase = .idle
        pull = 0
        pullV = 0
        raw = 0
        armed = false
        drive = .follow
        busX = scene.from
        lastX = busX
        busV = 0
        smV = 0
        smA = 0
        tilt = 0
        tiltV = 0
        kneel = 0
        kneelV = 0
        outcome = nil
    }
}
