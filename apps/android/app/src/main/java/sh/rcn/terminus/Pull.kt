package sh.rcn.terminus

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.sin

/*
 * Pull to refresh, "the bus pulls in": Now and the Buses tab come down to
 * show a strip of road behind them, a bus rolls in to its stop as they come,
 * and letting go past the stop asks again. The numbers and the motion are
 * here, without Compose, so they're tested on the JVM (PullTest); the
 * drawing is ui/BusPull.kt. The web's pull runs on the same rules.
 *
 * Everything is in dp, from the top of the screen, and seconds or
 * milliseconds as named.
 */

/** What a pull came to, said in a chip once the page has closed up. */
enum class PullOutcome {
    /** Asked, and the answer came back. */
    Updated,

    /** Not asked: the screen's answer is under [Pull.FRESH_MS] old, and the server would send the same. */
    UpToDate,

    /** Asked, and nothing came back. */
    Failed,
}

/** The words over the road while pulling. */
enum class PullHint { Pull, LetGo, Checking }

object Pull {
    /**
     * How far the page comes down below the status bar before letting go
     * asks again, and where it waits while it asks: just room for the bus,
     * the stop and the words beside it.
     */
    const val THRESHOLD = 76f
    const val HOLD = 72f

    /** The most it ever comes down below the status bar, however far the finger goes. */
    const val MAX = 150f

    /**
     * An answer younger than this isn't asked for again: the server keeps
     * arrivals for 15 s (TTL.arrivalsMs), so asking sooner gets the same.
     */
    const val FRESH_MS = 15_000L

    /** The shortest a refresh shows for, from letting go: long enough to see the bus off, never longer. */
    const val MIN_SHOW_MS = 700L

    /** The short refresh played when nothing was asked ([PullOutcome.UpToDate]). */
    const val QUICK_MS = 600L

    /** How long the chip saying how it went stays. */
    const val CHIP_MS = 2_400L

    /** The page's travel for a finger's [raw] travel: each dp further moves it less, up to [max]. */
    fun rubber(raw: Float, max: Float): Float = max * (1 - exp(-raw.coerceAtLeast(0f) / (max * 1.05f)))

    /** The finger's travel that brings the page to [pull]: [rubber] backwards. */
    fun unrubber(pull: Float, max: Float): Float = -(max * 1.05f) * ln(1 - pull.coerceIn(0f, max - 0.01f) / max)

    /** Ask the server, or not: never within [FRESH_MS] of the last answer that came back ([lastOkMs], null for none). */
    fun shouldFetch(lastOkMs: Long?, nowMs: Long): Boolean = lastOkMs == null || nowMs - lastOkMs !in 0 until FRESH_MS

    /** The chip for a pull: whether it asked, and whether the answer came. */
    fun outcome(fetched: Boolean, ok: Boolean): PullOutcome = when {
        !fetched -> PullOutcome.UpToDate
        ok -> PullOutcome.Updated
        else -> PullOutcome.Failed
    }

    /** How long a refresh shows at least, from letting go. */
    fun minShowMs(outcome: PullOutcome): Long = if (outcome == PullOutcome.UpToDate) QUICK_MS else MIN_SHOW_MS

    /** 0 at rest to 1 at the stop: how far below the status bar ([top]) the page has come, of [THRESHOLD]. */
    fun progress(pull: Float, top: Float): Float = ((pull - top) / THRESHOLD).coerceIn(0f, 1f)

    /** Past the stop: letting go now asks again. */
    fun armed(pull: Float, top: Float): Boolean = pull - top >= THRESHOLD

    /** The bus's x for [progress]: in from [start], easing into [stop] as the page nears the threshold. */
    fun busX(progress: Float, start: Float, stop: Float): Float =
        start + (stop - start) * (1 - (1 - progress.coerceIn(0f, 1f)).pow(1.6f))

    /** The colour after [i] for a bus going round again: the others in turn, 1 to [others], never the first's (0). */
    fun nextColour(i: Int, others: Int): Int = if (others <= 0) 0 else (i % others) + 1

    /** One step of a spring from [x] (moving at [v]) towards [target]: the new place and speed. */
    fun spring(x: Float, v: Float, target: Float, k: Float, c: Float, dt: Float): Pair<Float, Float> {
        val nv = v + (k * (target - x) - c * v) * dt
        return (x + nv * dt) to nv
    }
}

/**
 * The scene behind the page, in dp across the screen ([width]) and down
 * the strip, whose foot is on the page's top edge: the road, your stop's
 * sign and where the bus pulls up, its [scale] times the horizon's numbers.
 */
class PullScene(val width: Float) {
    val height = 104f
    val scale = 1.4f
    val road = height - 12f
    val sign = width * 0.75f

    /** The bus pulls up just short of the sign, as on Now's horizon. */
    val stop = sign - 44 * scale
    val start = -40 * scale - 6
    val busTop = road - 13.2f * scale
}

/** A puff of exhaust, where it left the bus and how old it is (s). */
data class Puff(val x: Float, val y: Float, var age: Float = 0f)

/**
 * A pull, frame by frame: the page's travel, the bus, its door, its horn,
 * its suspension, and the puffs behind it. [drag] and [release] follow the
 * finger, [done] the answer, and [step] moves it all on; what's drawn reads
 * the fields. [top] is the status bar's height (dp), which the page's travel
 * starts under; [calm]: the phone's "Remove animations", so nothing drives,
 * bounces or puffs.
 */
class PullMotion(val scene: PullScene, val top: Float, val others: Int, var calm: Boolean = false) {
    enum class Phase {
        Idle, Drag,

        /** Let go short of the stop: back to rest, nothing asked. */
        Cancel,

        /** Asking: the page waits at [Pull.HOLD]. */
        Busy,

        /** Closing up, the answer in. */
        Closing,
    }

    /** The bus while the page waits: at the stop, pulling away, then others going round. */
    enum class Drive { Boarding, Departing, Looping, Gone }

    var phase = Phase.Idle
        private set
    var drive = Drive.Boarding
        private set

    /** How far the page has come down, from the top of the screen. */
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
    private var outcome: PullOutcome? = null

    /** How it went, once the page starts closing; null until then. */
    var result: PullOutcome? = null
        private set

    var busX = scene.start
        private set
    private var busV = 0f
    private var lastX = scene.start
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
    var alpha = 1f
        private set
    val puffs = mutableListOf<Puff>()
    private var puffEvery = 0f

    private val hold get() = top + Pull.HOLD

    /** Whether anything still moves (a frame is wanted). */
    val moving: Boolean get() = phase != Phase.Idle || puffs.isNotEmpty()

    /** The page is out of its place: the scene shows. */
    val open: Boolean get() = pull > 0.5f

    /** The words over the road. */
    val hint: PullHint
        get() = when (phase) {
            Phase.Busy, Phase.Closing -> PullHint.Checking
            else -> if (armed) PullHint.LetGo else PullHint.Pull
        }

    /** The words' opacity: there once there's room for them, and while asking. */
    val hintAlpha: Float
        get() = if (phase == Phase.Busy) 1f else ((pull - top - 40f) / 24f).coerceIn(0f, 1f)

    /** The sign lit: past the stop, or the bus at it. */
    val lit: Boolean get() = armed || (phase == Phase.Busy && (calm || drive == Drive.Boarding))

    /** The bus dipping and rocking as it goes, in dp; none when calm. */
    val bob: Float
        get() = if (calm) 0f else kneel + 0.25f * sin(dist / 5f) * (abs(smV) / 250f).coerceIn(0f, 1f) + if (armed) 0.08f * sin(t * 70f) else 0f

    /** The time, in seconds, for the sign's halo. */
    val clock: Float get() = t

    /** Can a finger take the page now: at rest, or on its way back. */
    val canGrab: Boolean get() = phase == Phase.Idle || phase == Phase.Cancel

    /**
     * The finger moved [dy] dp (down positive) with the content at its top;
     * true when this crossed into armed, for a tick. Taken back up, the page
     * goes first, then the content scrolls.
     */
    fun drag(dy: Float): Boolean {
        if (!canGrab && phase != Phase.Drag) return false
        if (phase != Phase.Drag) {
            phase = Phase.Drag
            // Caught on its way back: the finger takes it from where it is.
            raw = if (pull <= top) pull else top + Pull.unrubber(pull - top, Pull.MAX)
            colour = 0
            result = null
        }
        raw = (raw + dy).coerceAtLeast(0f)
        // The status bar's strip comes first, one for one, so the road shows under it from the start.
        pull = if (raw <= top) raw else top + Pull.rubber(raw - top, Pull.MAX)
        pullV = 0f
        val was = armed
        armed = Pull.armed(pull, top)
        if (raw == 0f) phase = Phase.Idle
        return armed && !was
    }

    /** How much of an upward [dy] (negative) the page takes back before the content scrolls. */
    fun takeBack(dy: Float): Float {
        if (phase != Phase.Drag || dy >= 0f) return 0f
        val used = maxOf(dy, -raw)
        drag(used)
        return used
    }

    /** Let go: true when it asks again (past the stop), so the caller fetches and calls [done]. */
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

    /** The answer is in: the page closes once it's shown for [Pull.minShowMs]. */
    fun done(o: PullOutcome) {
        if (phase == Phase.Busy) outcome = o
    }

    private fun close() {
        phase = Phase.Closing
        result = outcome
    }

    /** Moves everything on by [dt] seconds. */
    fun step(dtIn: Float) {
        val dt = dtIn.coerceIn(0f, 0.05f)
        t += dt
        sinceMs += dt * 1000
        driveMs += dt * 1000

        if (phase == Phase.Busy) outcome?.let { if (sinceMs >= Pull.minShowMs(it)) close() }

        // The page: with the finger, else to where the phase wants it.
        if (phase != Phase.Drag && phase != Phase.Idle) {
            val target = if (phase == Phase.Busy) hold else 0f
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

    private fun stepCalm() {
        busX = scene.stop
        tilt = 0f
        kneel = 0f
        alpha = when (phase) {
            Phase.Drag, Phase.Cancel -> ((pull - top - 10f) / (Pull.THRESHOLD - 10f)).coerceIn(0f, 1f)
            Phase.Idle -> 0f
            else -> 1f
        }
        door = if (phase == Phase.Busy) 1f else 0f
    }

    private fun stepDriving(dt: Float) {
        alpha = 1f
        when (phase) {
            Phase.Drag, Phase.Cancel, Phase.Idle -> busX = Pull.busX(Pull.progress(pull, top), scene.start, scene.stop)
            Phase.Busy, Phase.Closing -> drive(dt)
        }
        // Suspension: the body pitches with the acceleration and settles on a spring; it kneels at the stop.
        val step = dt.coerceAtLeast(1 / 240f)
        val v = (busX - lastX) / step
        lastX = busX
        val a = (v - smV) / step
        smV += (v - smV) * 0.35f
        smA += (a - smA) * 0.2f
        Pull.spring(tilt, tiltV, (-smA * 0.0035f).coerceIn(-4.5f, 4.5f), 160f, 9f, dt).let { (x, nv) -> tilt = x; tiltV = nv }
        val kneeling = armed || (phase == Phase.Busy && drive == Drive.Boarding)
        Pull.spring(kneel, kneelV, if (kneeling) 0.55f else 0f, 140f, 10f, dt).let { (x, nv) -> kneel = x; kneelV = nv }
        dist += abs(v * dt)
        wheel += v * dt / (2.2f * scene.scale)
        // Exhaust as it pulls away.
        if (drive == Drive.Departing || (drive == Drive.Looping && busX < 40f)) {
            puffEvery -= dt
            if (puffEvery <= 0f && phase != Phase.Idle) {
                puffEvery = 0.07f
                puffs += Puff(busX - 2f, scene.busTop + 9 * scene.scale)
            }
        }
    }

    /** The bus while the page waits or closes: boards, honks, drives off, and others go round until the answer's in. */
    private fun drive(dt: Float) {
        when (drive) {
            Drive.Boarding -> {
                busX = scene.stop
                val s = driveMs
                door = if ((s > 60 && s < 190) || (s > 300 && s < 430)) 1f else 0f
                honk = if (s > 140 && s < 560) sin((s - 140) / 420 * Math.PI.toFloat()) else 0f
                // Closing early: it leaves now rather than finishing its stop.
                if (s > 620 || phase == Phase.Closing) {
                    drive = Drive.Departing
                    driveMs = 0f
                    busV = 40f
                }
            }
            Drive.Departing -> {
                busV += 1150 * dt
                busX += busV * dt
                if (busX > scene.width + 30) lap(cruise = 430f)
            }
            Drive.Looping -> {
                busX += busV * dt
                if (busX > scene.width + 30) lap(cruise = busV)
            }
            Drive.Gone -> busX = scene.width + 60
        }
    }

    /** Off the right: the next one in from the left in the next livery, unless the page is closing. */
    private fun lap(cruise: Float) {
        if (phase == Phase.Closing) {
            drive = Drive.Gone
            return
        }
        drive = Drive.Looping
        busX = scene.start - 10
        lastX = busX
        busV = cruise
        colour = Pull.nextColour(colour, others)
    }

    private fun rest() {
        phase = Phase.Idle
        pull = 0f
        pullV = 0f
        raw = 0f
        armed = false
        busX = scene.start
        lastX = busX
        busV = 0f
        smV = 0f
        smA = 0f
        tilt = 0f
        tiltV = 0f
        kneel = 0f
        kneelV = 0f
        drive = Drive.Boarding
        colour = 0
        outcome = null
    }
}
