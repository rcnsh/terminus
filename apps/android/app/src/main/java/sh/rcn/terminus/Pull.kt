package sh.rcn.terminus

import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.pow
import kotlin.math.roundToInt
import kotlin.math.sin

enum class PullOutcome {
    Updated,
    UpToDate,
    Failed,
}

enum class PullHint {
    Pull,
    LetGo,
    Checking,
    Updated,
    UpToDate,
    Failed,
}

object Pull {
    const val ARM = 84f

    const val HOLD = 40f

    const val MAX = 170f

    private const val SOFT = 200f

    const val LEAD = 0.12f

    const val FRESH_MS = 15_000L

    const val MIN_SHOW_MS = 700L

    const val QUICK_MS = 600L

    const val RESULT_MS = 1_000L

    const val START = -60f

    const val SHORT_OF_SIGN = 44f

    fun rubber(raw: Float): Float = MAX * (1 - exp(-raw.coerceAtLeast(0f) / SOFT))

    fun unrubber(pull: Float): Float = -SOFT * ln(1 - pull.coerceIn(0f, MAX - 0.01f) / MAX)

    fun lead(pull: Float): Float = pull * LEAD

    fun shouldFetch(lastOkMs: Long?, nowMs: Long): Boolean = lastOkMs == null || nowMs - lastOkMs !in 0 until FRESH_MS

    fun inS(atMs: Long?, nowMs: Long): Int? = atMs?.takeIf { it > nowMs }?.let { ((it - nowMs + 999) / 1000).toInt().coerceAtLeast(1) }

    fun outcome(fetched: Boolean, ok: Boolean): PullOutcome =
        when {
            !fetched -> PullOutcome.UpToDate
            ok -> PullOutcome.Updated
            else -> PullOutcome.Failed
        }

    fun minShowMs(outcome: PullOutcome): Long = if (outcome == PullOutcome.UpToDate) QUICK_MS else MIN_SHOW_MS

    fun progress(pull: Float): Float = (pull / ARM).coerceIn(0f, 1f)

    fun armed(pull: Float): Boolean = pull >= ARM

    fun busX(progress: Float, start: Float, stop: Float): Float = start + (stop - start) * (1 - (1 - progress.coerceIn(0f, 1f)).pow(1.6f))

    fun hintAlpha(pull: Float, held: Boolean): Float = if (held) 1f else ((pull - 22f) / 22f).coerceIn(0f, 1f)

    fun signGrow(pull: Float, held: Boolean): Float = if (held) 1f else ((pull - 6f) / 34f).coerceIn(0f, 1f)

    fun pillCentre(above: Float, room: Float, pull: Float): Float = (lead(pull) - above + room) / 2

    fun spring(x: Float, v: Float, target: Float, k: Float, c: Float, dt: Float): Pair<Float, Float> {
        val nv = v + (k * (target - x) - c * v) * dt
        return (x + nv * dt) to nv
    }

    fun roadSign(w: Float): Float = minOf((w * 0.7f).roundToInt().toFloat(), (w * 0.74f).roundToInt().toFloat() - 7)

    fun roadBus(sign: Float, far: Float): Float = (sign - SHORT_OF_SIGN - far.coerceIn(0f, 1f) * (sign - 56)).roundToInt().toFloat()

    fun hillSign(w: Float): Float = (w * 0.68f).roundToInt().toFloat()
}

data class PullScene(val width: Float, val sign: Float, val home: Float? = null) {
    val stop: Float
        get() = sign - Pull.SHORT_OF_SIGN

    val from: Float
        get() = home ?: Pull.START

    val rest: Float
        get() = home ?: stop
}

data class Puff(val x: Float, var age: Float = 0f)

class PullMotion(var scene: PullScene, var calm: Boolean = false) {
    enum class Phase {
        Idle,
        Drag,
        Cancel,
        Busy,
        Shown,
        Closing,
    }

    enum class Drive {
        Follow,
        Boarding,
        Departing,
        Looping,
        Return,
    }

    var phase = Phase.Idle
        private set

    var drive = Drive.Follow
        private set

    var pull = 0f
        private set

    private var pullV = 0f
    private var raw = 0f
    var armed = false
        private set

    var sinceMs = 0f
        private set

    private var driveMs = 0f
    private var shownMs = 0f
    private var outcome: PullOutcome? = null

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

    var door = 0f
        private set

    var honk = 0f
        private set

    var alpha = 1f
        private set

    private val puffing = mutableListOf<Puff>()

    val puffs: List<Puff>
        get() = puffing

    private var puffEvery = 0f

    val moving: Boolean
        get() = phase != Phase.Idle || puffs.isNotEmpty()

    val open: Boolean
        get() = phase != Phase.Idle

    val held: Boolean
        get() = phase == Phase.Busy || phase == Phase.Shown

    val hint: PullHint?
        get() =
            when (phase) {
                Phase.Idle -> null
                Phase.Drag,
                Phase.Cancel -> if (armed) PullHint.LetGo else PullHint.Pull
                Phase.Busy -> PullHint.Checking
                Phase.Shown,
                Phase.Closing ->
                    when (result) {
                        PullOutcome.Updated -> PullHint.Updated
                        PullOutcome.UpToDate -> PullHint.UpToDate
                        PullOutcome.Failed -> PullHint.Failed
                        null -> PullHint.Pull
                    }
            }

    val hintAlpha: Float
        get() = Pull.hintAlpha(pull, held)

    val signGrow: Float
        get() = Pull.signGrow(pull, held)

    val lead: Float
        get() = Pull.lead(pull)

    val lit: Boolean
        get() = armed || phase == Phase.Busy

    val good: Boolean
        get() = (phase == Phase.Shown || (phase == Phase.Closing && pull > 0f)) && result != null && result != PullOutcome.Failed

    val bob: Float
        get() = if (calm) 0f else kneel + 0.25f * sin(dist / 5f) * (abs(smV) / 200f).coerceIn(0f, 1f)

    val clock: Float
        get() = t

    val canGrab: Boolean
        get() = phase == Phase.Idle || phase == Phase.Cancel

    private var scrolled = false

    fun touch() {
        scrolled = false
    }

    fun contentScrolled() {
        if (phase != Phase.Drag) scrolled = true
    }

    fun drag(dy: Float): Boolean {
        if (phase != Phase.Drag && (!canGrab || scrolled)) return false
        if (phase != Phase.Drag) {
            if (phase == Phase.Idle) {
                busX = scene.from
                lastX = busX
            }
            phase = Phase.Drag
            drive = Drive.Follow
            raw = Pull.unrubber(pull)
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

    fun takeBack(dy: Float): Float {
        if (phase != Phase.Drag || dy >= 0f) return 0f
        val used = maxOf(dy, -raw)
        drag(used)
        return used
    }

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

    fun done(o: PullOutcome) {
        if (phase == Phase.Busy) outcome = o
    }

    fun step(dtIn: Float) {
        val dt = dtIn.coerceIn(0f, 0.05f)
        t += dt
        sinceMs += dt * 1000
        driveMs += dt * 1000

        if (phase == Phase.Busy) outcome?.let { if (sinceMs >= Pull.minShowMs(it)) show(it) }
        if (phase == Phase.Shown) {
            shownMs += dt * 1000
            if (shownMs >= Pull.RESULT_MS) phase = Phase.Closing
        }

        if (phase != Phase.Drag && phase != Phase.Idle) {
            val target = if (held) Pull.HOLD else 0f
            if (calm) {
                pull += (target - pull) * (1 - exp(-dt * 14f))
                pullV = 0f
            } else {
                val (x, v) =
                    if (phase == Phase.Closing) Pull.spring(pull, pullV, target, 240f, 31f, dt)
                    else Pull.spring(pull, pullV, target, 190f, 26f, dt)
                pull = x
                pullV = v
            }
            if ((phase == Phase.Cancel || phase == Phase.Closing) && pull < 0.4f && abs(pullV) < 5f) {
                pull = 0f
                pullV = 0f
                if (phase == Phase.Cancel || busHome) rest()
            }
        }

        door = 0f
        honk = 0f
        if (calm) stepCalm() else stepDriving(dt)
        puffing.removeAll { p ->
            p.age += dt
            p.age >= 0.6f
        }
    }

    private val busHome: Boolean
        get() = calm || scene.home == null || (drive == Drive.Return && abs(busX - scene.rest) < 1f)

    private fun show(o: PullOutcome) {
        phase = Phase.Shown
        result = o
        shownMs = 0f
        if (drive == Drive.Boarding) depart()
    }

    private fun depart() {
        drive = Drive.Departing
        driveMs = 0f
        busV = 30f
    }

    private fun stepCalm() {
        val home = scene.home
        busX = home ?: scene.stop
        tilt = 0f
        kneel = 0f
        alpha =
            when {
                home != null -> 1f
                phase == Phase.Idle -> 0f
                held -> 1f
                else -> ((pull - 10f) / (Pull.ARM - 10f)).coerceIn(0f, 1f)
            }
        door = if (phase == Phase.Busy && home == null) 1f else 0f
    }

    private fun stepDriving(dt: Float) {
        alpha = if (scene.home == null && (phase == Phase.Closing || phase == Phase.Cancel) && drive != Drive.Follow) signGrow else 1f
        when (drive) {
            Drive.Follow -> busX = Pull.busX(Pull.progress(pull), scene.from, scene.stop)
            else -> drive(dt)
        }
        val step = dt.coerceAtLeast(1 / 240f)
        val v = (busX - lastX) / step
        lastX = busX
        val a = (v - smV) / step
        smV += (v - smV) * 0.35f
        smA += (a - smA) * 0.2f
        Pull.spring(tilt, tiltV, (-smA * 0.004f).coerceIn(-4.5f, 4.5f), 160f, 9f, dt).let { (x, nv) ->
            tilt = x
            tiltV = nv
        }
        val kneeling = armed || drive == Drive.Boarding
        Pull.spring(kneel, kneelV, if (kneeling) 0.55f else 0f, 140f, 10f, dt).let { (x, nv) ->
            kneel = x
            kneelV = nv
        }
        dist += abs(v * dt)
        wheel += v * dt / 2.2f
        if (drive == Drive.Departing || (drive == Drive.Looping && busX < 30f)) {
            puffEvery -= dt
            if (puffEvery <= 0f) {
                puffEvery = 0.07f
                puffing += Puff(busX - 2f)
            }
        }
    }

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
                val to = scene.rest
                busX += (to - busX) * (1 - exp(-dt * 6f))
                if (abs(busX - to) < 0.05f) busX = to
            }
        }
    }

    private fun lap(cruise: Float) {
        busX = Pull.START - 10
        lastX = busX
        if (phase == Phase.Busy) {
            drive = Drive.Looping
            busV = cruise
        } else {
            drive = Drive.Return
            busV = 0f
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
        outcome = null
    }
}
