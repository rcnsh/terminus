package sh.rcn.terminus

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

/*
 * Pull to refresh, "the sky stretches": pulled down at the top of its
 * content, Now and the Buses tab stretch their own sky. The room above the
 * card's words (or the stop's name) grows with the pull, the sky's gradient
 * runs down to the horizon's new place, and the horizon is the animation:
 * a bus drives to your stop's sign as you pull, and letting go past the
 * point where it arrives asks again. Nothing opens above the page, so there
 * is no edge to see. The numbers and the motion are here, without Compose,
 * so they're tested on the JVM (PullTest); the drawing is ui/BusPull.kt.
 * The web's pull runs on the same numbers.
 *
 * The pull is in dp; the scene (where the bus and the sign are) in the
 * horizon's own units; times in seconds or milliseconds as named.
 */

/** What a pull came to, said in the pill before the sky closes up. */
enum class PullOutcome {
    /** Asked, and the answer came back. */
    Updated,

    /** Not asked: the screen's answer is under [Pull.FRESH_MS] old, and the server would send the same. */
    UpToDate,

    /** Asked, and nothing came back. */
    Failed,
}

/** The words in the pill, from the first pull to how it went. */
enum class PullHint { Pull, LetGo, Checking, Updated, UpToDate, Failed }

object Pull {
    /** How far the sky stretches (dp) before letting go asks again: the bus is at the stop. */
    const val ARM = 84f

    /** Where it waits while it asks: room for the pill and no more, less than [ARM]. */
    const val HOLD = 40f

    /** The most it ever stretches, however far the finger goes. */
    const val MAX = 170f

    /** The finger's travel over which the stretch eases towards [MAX]: [rubber]. */
    private const val SOFT = 200f

    /** How far the header and chips come down, of the stretch: a little, so the room opens under them. */
    const val LEAD = 0.12f

    /**
     * An answer younger than this isn't asked for again: the server keeps
     * arrivals for 15 s (TTL.arrivalsMs), so asking sooner gets the same.
     */
    const val FRESH_MS = 15_000L

    /** The shortest a refresh shows for, from letting go: long enough to see the bus off, never longer. */
    const val MIN_SHOW_MS = 700L

    /** The short refresh played when nothing was asked ([PullOutcome.UpToDate]). */
    const val QUICK_MS = 600L

    /** How long the pill says how it went before the sky closes. */
    const val RESULT_MS = 1_000L

    /** The longest it waits on top of [RESULT_MS] for the bus to be back in its place. */
    const val RESULT_MAX_MS = 1_600L

    /** Where a bus comes in from: off the left of the horizon. */
    const val START = -60f

    /** The bus pulls up this far short of the sign (its length and a little). */
    const val SHORT_OF_SIGN = 44f

    /** The stretch for a finger's [raw] travel (dp): each dp further moves it less, up to [MAX]. */
    fun rubber(raw: Float): Float = MAX * (1 - exp(-raw.coerceAtLeast(0f) / SOFT))

    /** The finger's travel that stretches it to [pull]: [rubber] backwards. */
    fun unrubber(pull: Float): Float = -SOFT * ln(1 - pull.coerceIn(0f, MAX - 0.01f) / MAX)

    /** How far the header and chips come down for [pull]. */
    fun lead(pull: Float): Float = pull * LEAD

    /** Ask the server, or not: never within [FRESH_MS] of the last answer that came back ([lastOkMs], null for none). */
    fun shouldFetch(lastOkMs: Long?, nowMs: Long): Boolean = lastOkMs == null || nowMs - lastOkMs !in 0 until FRESH_MS

    /** How a pull went: whether it asked, and whether the answer came. */
    fun outcome(fetched: Boolean, ok: Boolean): PullOutcome = when {
        !fetched -> PullOutcome.UpToDate
        ok -> PullOutcome.Updated
        else -> PullOutcome.Failed
    }

    /** How long a refresh shows at least, from letting go. */
    fun minShowMs(outcome: PullOutcome): Long = if (outcome == PullOutcome.UpToDate) QUICK_MS else MIN_SHOW_MS

    /** 0 at rest to 1 where letting go asks. */
    fun progress(pull: Float): Float = (pull / ARM).coerceIn(0f, 1f)

    /** Stretched far enough: letting go now asks again. */
    fun armed(pull: Float): Boolean = pull >= ARM

    /** The bus's x for [progress]: from [start], easing into [stop] as the stretch nears [ARM]. */
    fun busX(progress: Float, start: Float, stop: Float): Float =
        start + (stop - start) * (1 - (1 - progress.coerceIn(0f, 1f)).pow(1.6f))

    /** The pill's opacity: there once there's room for it, and all the while it waits. */
    fun hintAlpha(pull: Float, held: Boolean): Float = if (held) 1f else ((pull - 22f) / 22f).coerceIn(0f, 1f)

    /** How much of the sign shows (0–1), where the horizon has none of its own: it grows in as the sky opens. */
    fun signGrow(pull: Float, held: Boolean): Float = if (held) 1f else ((pull - 6f) / 34f).coerceIn(0f, 1f)

    /**
     * The pill's centre, from the top of the room that opened: halfway between
     * what's above it ([above] up from the room's top, come down by its
     * [lead]) and the words under the room ([room] down).
     */
    fun pillCentre(above: Float, room: Float, pull: Float): Float = (lead(pull) - above + room) / 2

    /** The colour after [i] for a bus going round again: the others in turn, 1 to [others], never the first's (0). */
    fun nextColour(i: Int, others: Int): Int = if (others <= 0) 0 else (i % others) + 1

    /** One step of a spring from [x] (moving at [v]) towards [target]: the new place and speed. */
    fun spring(x: Float, v: Float, target: Float, k: Float, c: Float, dt: Float): Pair<Float, Float> {
        val nv = v + (k * (target - x) - c * v) * dt
        return (x + nv * dt) to nv
    }

    /* The horizons' places, shared with their drawing (ui/NightSky.kt). */

    /** Now's horizon, [w] units across: your stop's sign, left of the flag. */
    fun roadSign(w: Float): Float = minOf((w * 0.7f).roundToInt().toFloat(), (w * 0.74f).roundToInt().toFloat() - 7)

    /** Now's horizon: your bus, [far] (0 at the stop, 1 a quarter of an hour away) along the road to the sign at [sign]. */
    fun roadBus(sign: Float, far: Float): Float = (sign - SHORT_OF_SIGN - far.coerceIn(0f, 1f) * (sign - 56)).roundToInt().toFloat()

    /** The low horizon (Buses), [w] units across: where a stop's sign grows out of the near hill. */
    fun hillSign(w: Float): Float = (w * 0.68f).roundToInt().toFloat()
}

/**
 * Where the pull's bus drives, in its horizon's units: [width] across, the
 * sign at [sign], and [home], where the card has its bus (null: none, so
 * one comes in from off the left and waits at the stop).
 */
data class PullScene(val width: Float, val sign: Float, val home: Float? = null) {
    /** The bus pulls up just short of the sign. */
    val stop: Float get() = sign - Pull.SHORT_OF_SIGN

    /** Where the bus starts as the pull begins. */
    val from: Float get() = home ?: Pull.START

    /** Where it comes back to once the answer's in. */
    val rest: Float get() = home ?: stop
}

/** A puff of exhaust: where it left the bus (x, units) and how old it is (s). */
data class Puff(val x: Float, var age: Float = 0f)

/**
 * A pull, frame by frame: the stretch, the bus, its door, its horn, its
 * suspension, and the puffs behind it. [drag] and [release] follow the
 * finger, [done] the answer, and [step] moves it all on; what's drawn reads
 * the fields. [scene] can change as the data does (the card's bus moves).
 * [calm]: the phone's "Remove animations", so nothing drives, bounces or
 * puffs, and the sky returns without a spring.
 */
class PullMotion(var scene: PullScene, var others: Int, var calm: Boolean = false) {
    enum class Phase {
        Idle, Drag,

        /** Let go short of [Pull.ARM]: back to rest, nothing asked. */
        Cancel,

        /** Asking: the sky waits at [Pull.HOLD]. */
        Busy,

        /** The answer's in and said, still at the hold. */
        Shown,

        /** Closing up. */
        Closing,
    }

    /** What the bus is doing: with the finger, at the stop, pulling away, others going round, coming back to its place. */
    enum class Drive { Follow, Boarding, Departing, Looping, Return }

    var phase = Phase.Idle
        private set
    var drive = Drive.Follow
        private set

    /** How far the sky has stretched (dp). */
    var pull = 0f
        private set
    private var pullV = 0f
    private var raw = 0f
    var armed = false
        private set

    /** Milliseconds since letting go. */
    var sinceMs = 0f
        private set
    private var driveMs = 0f
    private var shownMs = 0f
    private var outcome: PullOutcome? = null

    /** How it went, once it's said; null until then. */
    var result: PullOutcome? = null
        private set

    var busX = scene.from
        private set
    private var busV = 0f
    private var lastX = busX
    private var smV = 0f
    private var smA = 0f
    var tilt = 0f
        private set
    private var tiltV = 0f
    var kneel = 0f
        private set
    private var kneelV = 0f
    var wheel = 0f
        private set
    private var dist = 0f
    private var t = 0f

    /** Which livery the bus is in: 0 the screen's own, then the others in turn as they go round. */
    var colour = 0
        private set
    var door = 0f
        private set
    var honk = 0f
        private set

    /** The bus's opacity: faded in where it stands rather than drives (calm, with no bus of the card's). */
    var alpha = 1f
        private set
    val puffs = mutableListOf<Puff>()
    private var puffEvery = 0f

    /** Whether anything still moves (a frame is wanted). */
    val moving: Boolean get() = phase != Phase.Idle || puffs.isNotEmpty()

    /** The pull's scene is on the horizon instead of the card's own sign and bus. */
    val open: Boolean get() = phase != Phase.Idle

    /** Waiting at the hold: asking, or saying how it went. */
    val held: Boolean get() = phase == Phase.Busy || phase == Phase.Shown

    /** The words in the pill; null at rest. */
    val hint: PullHint?
        get() = when (phase) {
            Phase.Idle -> null
            Phase.Drag, Phase.Cancel -> if (armed) PullHint.LetGo else PullHint.Pull
            Phase.Busy -> PullHint.Checking
            Phase.Shown, Phase.Closing -> when (result) {
                PullOutcome.Updated -> PullHint.Updated
                PullOutcome.UpToDate -> PullHint.UpToDate
                PullOutcome.Failed -> PullHint.Failed
                null -> PullHint.Pull
            }
        }

    val hintAlpha: Float get() = Pull.hintAlpha(pull, held)

    /** How much of a sign the horizon doesn't have shows. */
    val signGrow: Float get() = Pull.signGrow(pull, held)

    /** The header and chips' way down (dp). */
    val lead: Float get() = Pull.lead(pull)

    /** The sign lit in the accent: armed, and while it asks. */
    val lit: Boolean get() = armed || phase == Phase.Busy

    /** The sign green: the answer's in (or there was nothing new to ask for). */
    val good: Boolean get() = (phase == Phase.Shown || phase == Phase.Closing) && result != null && result != PullOutcome.Failed

    /** The bus dipping and rocking as it goes (units); none when calm. */
    val bob: Float
        get() = if (calm) 0f else kneel + 0.25f * sin(dist / 5f) * (abs(smV) / 200f).coerceIn(0f, 1f)

    /** The time, in seconds, for the sign's halo. */
    val clock: Float get() = t

    /** Can a finger take the sky now: at rest, or on its way back. */
    val canGrab: Boolean get() = phase == Phase.Idle || phase == Phase.Cancel

    /** The content has scrolled since the finger went down, so this touch can't start a pull. */
    private var scrolled = false

    /**
     * A finger went down. A pull only starts from a touch that began with
     * the content at its top: scrolling up into the top and on doesn't pull.
     */
    fun touch() {
        scrolled = false
    }

    /** The content scrolled under this touch. */
    fun contentScrolled() {
        if (phase != Phase.Drag) scrolled = true
    }

    /**
     * The finger moved [dy] dp (down positive) with the content at its top;
     * true when this crossed into armed, for a tick. Taken back up, the sky
     * goes first, then the content scrolls.
     */
    fun drag(dy: Float): Boolean {
        if (phase != Phase.Drag && (!canGrab || scrolled)) return false
        if (phase != Phase.Drag) {
            if (phase == Phase.Idle) {
                busX = scene.from
                lastX = busX
            }
            phase = Phase.Drag
            drive = Drive.Follow
            // Caught on its way back: the finger takes it from where it is.
            raw = Pull.unrubber(pull)
            colour = 0
            result = null
        }
        raw = (raw + dy).coerceAtLeast(0f)
        pull = Pull.rubber(raw)
        pullV = 0f
        val was = armed
        armed = Pull.armed(pull)
        if (armed && !was && !calm) kneelV += 14f
        if (raw == 0f) rest()
        return armed && !was
    }

    /** How much of an upward [dy] (negative) the sky takes back before the content scrolls. */
    fun takeBack(dy: Float): Float {
        if (phase != Phase.Drag || dy >= 0f) return 0f
        val used = maxOf(dy, -raw)
        drag(used)
        return used
    }

    /** Let go: true when it asks again (armed), so the caller fetches and calls [done]. */
    fun release(): Boolean {
        if (phase != Phase.Drag) return false
        val go = armed
        armed = false
        sinceMs = 0f
        if (go) {
            phase = Phase.Busy
            drive = Drive.Boarding
            driveMs = 0f
            outcome = null
            busV = 0f
            if (!calm) busX = scene.stop
        } else {
            phase = if (pull > 0f) Phase.Cancel else Phase.Idle
        }
        return go
    }

    /** The answer is in: said once it's shown for [Pull.minShowMs]. */
    fun done(o: PullOutcome) {
        if (phase == Phase.Busy) outcome = o
    }

    /** Moves everything on by [dtIn] seconds. */
    fun step(dtIn: Float) {
        val dt = dtIn.coerceIn(0f, 0.05f)
        t += dt
        sinceMs += dt * 1000
        driveMs += dt * 1000

        if (phase == Phase.Busy) outcome?.let { if (sinceMs >= Pull.minShowMs(it)) show(it) }
        if (phase == Phase.Shown) {
            shownMs += dt * 1000
            val home = calm || (drive == Drive.Return && abs(busX - scene.rest) < 1f)
            if ((shownMs >= Pull.RESULT_MS && home) || shownMs >= Pull.RESULT_MAX_MS) phase = Phase.Closing
        }

        // The stretch: with the finger, else to where the phase wants it.
        if (phase != Phase.Drag && phase != Phase.Idle) {
            val target = if (held) Pull.HOLD else 0f
            if (calm) {
                // Eased, never past where it's going.
                pull += (target - pull) * (1 - exp(-dt * 14f))
                pullV = 0f
            } else {
                val (x, v) = if (phase == Phase.Closing) Pull.spring(pull, pullV, target, 240f, 31f, dt) else Pull.spring(pull, pullV, target, 190f, 26f, dt)
                pull = x
                pullV = v
            }
            if ((phase == Phase.Cancel || phase == Phase.Closing) && pull < 0.4f && abs(pullV) < 5f) rest()
        }

        door = 0f
        honk = 0f
        if (calm) stepCalm() else stepDriving(dt)
        puffs.removeAll { p -> p.age += dt; p.age >= 0.6f }
    }

    private fun show(o: PullOutcome) {
        phase = Phase.Shown
        result = o
        shownMs = 0f
        // Still at the stop: it leaves now rather than finishing its stop.
        if (drive == Drive.Boarding) depart()
    }

    private fun depart() {
        drive = Drive.Departing
        driveMs = 0f
        busV = 30f
    }

    private fun stepCalm() {
        // Nothing drives: the card's bus stays in its place; with none, one stands at the stop, there as the sky opens.
        val home = scene.home
        busX = home ?: scene.stop
        tilt = 0f
        kneel = 0f
        alpha = when {
            home != null -> 1f
            phase == Phase.Idle -> 0f
            held -> 1f
            else -> ((pull - 10f) / (Pull.ARM - 10f)).coerceIn(0f, 1f)
        }
        door = if (phase == Phase.Busy && home == null) 1f else 0f
    }

    private fun stepDriving(dt: Float) {
        // Without a bus of the card's, the one at the stop sinks away with the sign as the sky closes.
        alpha = if (scene.home == null && (phase == Phase.Closing || phase == Phase.Cancel) && drive != Drive.Follow) signGrow else 1f
        when (drive) {
            Drive.Follow -> busX = Pull.busX(Pull.progress(pull), scene.from, scene.stop)
            else -> drive(dt)
        }
        // Suspension: the body pitches with the acceleration and settles on a spring; it kneels at the stop.
        val step = dt.coerceAtLeast(1 / 240f)
        val v = (busX - lastX) / step
        lastX = busX
        val a = (v - smV) / step
        smV += (v - smV) * 0.35f
        smA += (a - smA) * 0.2f
        Pull.spring(tilt, tiltV, (-smA * 0.004f).coerceIn(-4.5f, 4.5f), 160f, 9f, dt).let { (x, nv) -> tilt = x; tiltV = nv }
        val kneeling = armed || drive == Drive.Boarding
        Pull.spring(kneel, kneelV, if (kneeling) 0.55f else 0f, 140f, 10f, dt).let { (x, nv) -> kneel = x; kneelV = nv }
        dist += abs(v * dt)
        wheel += v * dt / 2.2f
        // Exhaust as it pulls away.
        if (drive == Drive.Departing || (drive == Drive.Looping && busX < 30f)) {
            puffEvery -= dt
            if (puffEvery <= 0f) {
                puffEvery = 0.07f
                puffs += Puff(busX - 2f)
            }
        }
    }

    /** The bus once it's let go: boards, honks, drives off, others go round until the answer's in, then it comes back. */
    private fun drive(dt: Float) {
        when (drive) {
            Drive.Follow -> Unit
            Drive.Boarding -> {
                busX = scene.stop
                val s = driveMs
                door = if ((s > 60 && s < 190) || (s > 300 && s < 430)) 1f else 0f
                honk = if (s > 140 && s < 560) sin((s - 140) / 420 * Math.PI.toFloat()) else 0f
                if (s > 620) depart()
            }
            Drive.Departing -> {
                busV += 560 * dt
                busX += busV * dt
                if (busX > scene.width + 30) lap(cruise = 240f)
            }
            Drive.Looping -> {
                busX += busV * dt
                if (busX > scene.width + 30) lap(cruise = busV)
            }
            Drive.Return -> {
                // Eases in to where the card has it, from off the left.
                val to = scene.rest
                busX += (to - busX) * (1 - exp(-dt * 6f))
                if (abs(busX - to) < 0.05f) busX = to
            }
        }
    }

    /** Off the right: the next one in from the left, in the next livery while it asks, else the card's own coming back. */
    private fun lap(cruise: Float) {
        busX = Pull.START - 10
        lastX = busX
        if (phase == Phase.Busy) {
            drive = Drive.Looping
            busV = cruise
            colour = Pull.nextColour(colour, others)
        } else {
            drive = Drive.Return
            busV = 0f
            colour = 0
        }
    }

    private fun rest() {
        phase = Phase.Idle
        pull = 0f
        pullV = 0f
        raw = 0f
        armed = false
        drive = Drive.Follow
        busX = scene.from
        lastX = busX
        busV = 0f
        smV = 0f
        smA = 0f
        tilt = 0f
        tiltV = 0f
        kneel = 0f
        kneelV = 0f
        colour = 0
        outcome = null
    }
}
