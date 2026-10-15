import CoreGraphics
import Foundation

/*
 * Pull to refresh, "the sky stretches": pulled down at the top of its
 * content, Now and the Buses tab stretch their own sky. The room above the
 * card's words (or the stop's name) grows with the pull, the sky's gradient
 * runs down to the horizon's new place, and the horizon is the animation:
 * a bus drives to your stop's sign as you pull, and letting go past the
 * point where it arrives asks again. Nothing opens above the page, so there
 * is no edge to see. The numbers and the motion are here, without SwiftUI,
 * so they're tested (PullTests); the drawing is SkyPull.swift. As Android's
 * Pull.kt, on the same numbers.
 *
 * The pull is in points; the scene (where the bus and the sign are) in the
 * horizon's own units; times in seconds or milliseconds as named.
 */

/// What a pull came to, said in the pill before the sky closes up.
enum PullOutcome: Equatable {
    /// Asked, and the answer came back.
    case updated
    /// Not asked: the answer is under `Pull.freshS` old, and the server would
    /// send the same. With when the screen's timed refresh brings new times, if it knows.
    case upToDate(nextInS: Int?)
    /// Asked, and nothing came back.
    case failed

    var words: String {
        switch self {
        case .updated: L("Updated just now")
        case .upToDate(let s?): L("Up to date, next update in %@ s", "\(s)")
        case .upToDate(nil): L("Up to date")
        case .failed: L("Couldn't update")
        }
    }

    /// The answer is in, or there was nothing new to ask for.
    var good: Bool { self != .failed }
}

/// The words in the pill, from the first pull to how it went.
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
    /// How far the sky stretches before letting go asks again: the bus is at the stop.
    static let arm: CGFloat = 84
    /// Where it waits while it asks: room for the pill and no more, less than `arm`.
    static let hold: CGFloat = 40
    /// The most it ever stretches, however far the finger goes.
    static let max: CGFloat = 170
    /// The finger's travel over which the stretch eases towards `max`: `rubber`.
    private static let soft: CGFloat = 200
    /// How far the header comes down, of the stretch: a little, so the room opens under it.
    static let leadShare: CGFloat = 0.12

    /// An answer younger than this isn't asked for again: the server keeps arrivals for 15 s.
    static let freshS: TimeInterval = 15
    /// The shortest a refresh shows for, from letting go: long enough to see the bus off, never longer.
    static let minShowMs: CGFloat = 700
    /// The short refresh played when nothing was asked (up to date).
    static let quickMs: CGFloat = 600
    /// How long the pill says how it went before the sky closes.
    static let resultMs: CGFloat = 1_000

    /// Where a bus comes in from: off the left of the horizon.
    static let start: CGFloat = -60
    /// The bus pulls up this far short of the sign (its length and a little).
    static let shortOfSign: CGFloat = 44

    /// The stretch for a finger's `raw` travel: each point further moves it less, up to `max`.
    static func rubber(_ raw: CGFloat) -> CGFloat { max * (1 - exp(-Swift.max(raw, 0) / soft)) }

    /// The finger's travel that stretches it to `pull`: `rubber` backwards.
    static func unrubber(_ pull: CGFloat) -> CGFloat { -soft * log(1 - Swift.min(Swift.max(pull, 0), max - 0.01) / max) }

    /// How far the header comes down for `pull`.
    static func lead(_ pull: CGFloat) -> CGFloat { pull * leadShare }

    /// Ask the server, or not: never within `freshS` of the last answer that came back (or a clock set back since).
    static func shouldFetch(lastOK: Date?, now: Date) -> Bool {
        guard let lastOK else { return true }
        let age = now.timeIntervalSince(lastOK)
        return age < 0 || age >= freshS
    }

    /// "next update in 9 s": whole seconds until `at`, rounded up, at least 1; nil with none due.
    static func inS(_ at: Date?, now: Date) -> Int? {
        guard let at, at > now else { return nil }
        return Swift.max(1, Int(ceil(at.timeIntervalSince(now))))
    }

    /// How long a refresh shows at least, from letting go.
    static func minShow(_ o: PullOutcome) -> CGFloat {
        if case .upToDate = o { return quickMs }
        return minShowMs
    }

    /// 0 at rest to 1 where letting go asks.
    static func progress(_ pull: CGFloat) -> CGFloat { Swift.min(Swift.max(pull / arm, 0), 1) }

    /// Stretched far enough: letting go now asks again.
    static func armed(_ pull: CGFloat) -> Bool { pull >= arm }

    /// The bus's x for `progress`: from `start`, easing into `stop` as the stretch nears `arm`.
    static func busX(_ progress: CGFloat, start: CGFloat, stop: CGFloat) -> CGFloat {
        start + (stop - start) * (1 - pow(1 - Swift.min(Swift.max(progress, 0), 1), 1.6))
    }

    /// The pill's opacity: there once there's room for it, and all the while it waits.
    static func hintAlpha(_ pull: CGFloat, held: Bool) -> CGFloat { held ? 1 : Swift.min(Swift.max((pull - 22) / 22, 0), 1) }

    /// How much of the sign shows (0–1), where the horizon has none of its own: it grows in as the sky opens.
    static func signGrow(_ pull: CGFloat, held: Bool) -> CGFloat { held ? 1 : Swift.min(Swift.max((pull - 6) / 34, 0), 1) }

    /// The pill's centre, from the top of the room that opened: halfway between
    /// what's above it (`above` up from the room's top, come down by its lead)
    /// and the words under the room (`room` down).
    static func pillCentre(above: CGFloat, room: CGFloat, pull: CGFloat) -> CGFloat { (lead(pull) - above + room) / 2 }

    /// One step of a spring from `x` (moving at `v`) towards `target`: the new place and speed.
    static func spring(_ x: CGFloat, _ v: CGFloat, target: CGFloat, k: CGFloat, c: CGFloat, dt: CGFloat) -> (CGFloat, CGFloat) {
        let nv = v + (k * (target - x) - c * v) * dt
        return (x + nv * dt, nv)
    }

    /// Now's horizon: your bus, `far` (0 at the stop, 1 a quarter of an hour away) along the road to the sign at `sign`.
    static func roadBus(_ sign: CGFloat, _ far: CGFloat) -> CGFloat { roadBusX(sign, far) }

    /// The low horizon (Buses), `w` units across: where a stop's sign grows out of the near hill.
    static func hillSign(_ w: CGFloat) -> CGFloat { (w * 0.68).rounded() }
}

/// Where the pull's bus drives, in its horizon's units: `width` across, the
/// sign at `sign`, and `home`, where the card has its bus (nil: none, so one
/// comes in from off the left and waits at the stop).
struct PullScene: Equatable {
    var width: CGFloat
    var sign: CGFloat
    var home: CGFloat?

    /// The bus pulls up just short of the sign.
    var stop: CGFloat { sign - Pull.shortOfSign }
    /// Where the bus starts as the pull begins.
    var from: CGFloat { home ?? Pull.start }
    /// Where it comes back to once the answer's in.
    var rest: CGFloat { home ?? stop }

    /// Now's road, `width` units across, with `road`'s bus (or the shuttle going by) at home.
    static func road(_ width: CGFloat, _ road: Road) -> PullScene {
        let sign = roadSign(width)
        let card = road.stop ? road.bus : nil
        return PullScene(width: width, sign: sign, home: card.map { Pull.roadBus(sign, $0.far) } ?? (road.shuttle ? shuttleX(width) : nil))
    }

    /// The Buses tab's low hills, `width` units across: no bus of its own.
    static func hill(_ width: CGFloat) -> PullScene { PullScene(width: width, sign: Pull.hillSign(width)) }
}

/// A puff of exhaust: where it left the bus (x, units) and how old it is (s).
struct Puff {
    var x: CGFloat
    var age: CGFloat = 0
}

/// A pull, frame by frame: the stretch, the bus, its door, its horn, its
/// suspension, and the puffs behind it. `drag` and `release` follow the
/// finger, `done` the answer, and `step` moves it all on; what's drawn reads
/// the fields. `scene` can change as the data does (the card's bus moves).
/// `calm`: Reduce Motion, so nothing drives, bounces or puffs, and the sky
/// returns without a spring.
final class PullMotion {
    enum Phase {
        case idle, drag
        /// Let go short of `Pull.arm`: back to rest, nothing asked.
        case cancel
        /// Asking: the sky waits at `Pull.hold`.
        case busy
        /// The answer's in and said, still at the hold.
        case shown
        /// Closing up, then the bus finishing its way back with the sky shut.
        case closing
    }

    /// What the bus is doing: with the finger, at the stop, pulling away, going round again, coming back to its place.
    enum Drive { case follow, boarding, departing, looping, back }

    var scene: PullScene
    var calm: Bool

    private(set) var phase = Phase.idle
    private(set) var drive = Drive.follow

    /// How far the sky has stretched (points).
    private(set) var pull: CGFloat = 0
    private var pullV: CGFloat = 0
    private var raw: CGFloat = 0
    private(set) var armed = false

    /// Milliseconds since letting go.
    private(set) var sinceMs: CGFloat = 0
    private var driveMs: CGFloat = 0
    private var shownMs: CGFloat = 0
    private var outcome: PullOutcome?

    /// How it went, once it's said; nil until then.
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

    /// The bus's opacity: faded in where it stands rather than drives (calm, with no bus of the card's).
    private(set) var alpha: CGFloat = 1
    private(set) var puffs: [Puff] = []
    private var puffEvery: CGFloat = 0

    init(scene: PullScene, calm: Bool = false) {
        self.scene = scene
        self.calm = calm
        busX = scene.from
        lastX = scene.from
    }

    /// Whether anything still moves (a frame is wanted).
    var moving: Bool { phase != .idle || !puffs.isEmpty }

    /// The pull's scene is on the horizon instead of the card's own sign and bus.
    var open: Bool { phase != .idle }

    /// Waiting at the hold: asking, or saying how it went.
    var held: Bool { phase == .busy || phase == .shown }

    /// The words in the pill; nil at rest.
    var hint: PullHint? {
        switch phase {
        case .idle: nil
        case .drag, .cancel: armed ? .letGo : .pull
        case .busy: .checking
        case .shown, .closing: result.map { .done($0) } ?? .pull
        }
    }

    var hintAlpha: CGFloat { Pull.hintAlpha(pull, held: held) }

    /// How much of a sign the horizon doesn't have shows.
    var signGrow: CGFloat { Pull.signGrow(pull, held: held) }

    /// The header's way down (points).
    var lead: CGFloat { Pull.lead(pull) }

    /// The sign lit in the accent: armed, and while it asks.
    var lit: Bool { armed || phase == .busy }

    /// The sign green: the answer's in (or there was nothing new to ask for), until the sky's shut.
    var good: Bool { (phase == .shown || (phase == .closing && pull > 0)) && result?.good == true }

    /// The bus dipping and rocking as it goes (units); none when calm.
    var bob: CGFloat { calm ? 0 : kneel + 0.25 * sin(dist / 5) * Swift.min(Swift.max(abs(smV) / 200, 0), 1) }

    /// The time, in seconds, for the sign's halo.
    var clock: CGFloat { t }

    /// Can a finger take the sky now: at rest, or on its way back.
    var canGrab: Bool { phase == .idle || phase == .cancel }

    /// The content has scrolled since the finger went down, so this touch can't start a pull.
    private var scrolled = false

    /// A finger went down. A pull only starts from a touch that began with
    /// the content at its top: scrolling up into the top and on doesn't pull.
    func touch() { scrolled = false }

    /// The content scrolled under this touch.
    func contentScrolled() {
        if phase != .drag { scrolled = true }
    }

    /// The finger moved `dy` points (down positive) with the content at its
    /// top; true when this crossed into armed, for a tick. Taken back up, the
    /// sky goes first, then the content scrolls.
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
            // Caught on its way back: the finger takes it from where it is.
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

    /// How much of an upward `dy` (negative) the sky takes back before the content scrolls.
    func takeBack(_ dy: CGFloat) -> CGFloat {
        guard phase == .drag, dy < 0 else { return 0 }
        let used = Swift.max(dy, -raw)
        drag(used)
        return used
    }

    /// Let go: true when it asks again (armed), so the caller fetches and calls `done`.
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

    /// The answer is in: said once it's shown for `Pull.minShow`.
    func done(_ o: PullOutcome) {
        if phase == .busy { outcome = o }
    }

    /// Moves everything on by `dtIn` seconds.
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

        // The stretch: with the finger, else to where the phase wants it.
        if phase != .drag && phase != .idle {
            let target = held ? Pull.hold : 0
            if calm {
                // Eased, never past where it's going.
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
                // The sky doesn't wait for the bus, nor the bus for the sky: it drives on home, unhurried.
                if phase == .cancel || busHome { rest() }
            }
        }

        door = 0
        honk = 0
        if calm { stepCalm() } else { stepDriving(dt) }
        for i in puffs.indices { puffs[i].age += dt }
        puffs.removeAll { $0.age >= 0.6 }
    }

    /// The bus is where the horizon has its own (or, with none of the card's, faded with the sign): the scene can go.
    private var busHome: Bool {
        calm || scene.home == nil || (drive == .back && abs(busX - scene.rest) < 1)
    }

    private func show(_ o: PullOutcome) {
        phase = .shown
        result = o
        shownMs = 0
        // Still at the stop: it leaves now rather than finishing its stop.
        if drive == .boarding { depart() }
    }

    private func depart() {
        drive = .departing
        driveMs = 0
        busV = 30
    }

    private func stepCalm() {
        // Nothing drives: the card's bus stays in its place; with none, one stands at the stop, there as the sky opens.
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
        // Without a bus of the card's, the one at the stop sinks away with the sign as the sky closes.
        alpha = scene.home == nil && (phase == .closing || phase == .cancel) && drive != .follow ? signGrow : 1
        if drive == .follow {
            busX = Pull.busX(Pull.progress(pull), start: scene.from, stop: scene.stop)
        } else {
            driveOn(dt)
        }
        // Suspension: the body pitches with the acceleration and settles on a spring; it kneels at the stop.
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
        // Exhaust as it pulls away.
        if drive == .departing || (drive == .looping && busX < 30) {
            puffEvery -= dt
            if puffEvery <= 0 {
                puffEvery = 0.07
                puffs.append(Puff(x: busX - 2))
            }
        }
    }

    /// The bus once it's let go: boards, honks, drives off, goes round again until the answer's in, then it comes back.
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
            // Eases in to where the card has it, from off the left.
            let to = scene.rest
            busX += (to - busX) * (1 - exp(-dt * 6))
            if abs(busX - to) < 0.05 { busX = to }
        }
    }

    /// Off the right: in again from the left, round once more while it asks, else coming back to its place.
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
