package sh.rcn.terminus.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.Board
import sh.rcn.terminus.BusTimes
import sh.rcn.terminus.CampusMap
import sh.rcn.terminus.L
import sh.rcn.terminus.Line
import sh.rcn.terminus.LineOut
import sh.rcn.terminus.LinesPoll
import sh.rcn.terminus.Locator
import sh.rcn.terminus.MapFiles
import sh.rcn.terminus.Outs
import sh.rcn.terminus.PinPages
import sh.rcn.terminus.PinnedStop
import sh.rcn.terminus.Pull
import sh.rcn.terminus.PullOutcome
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Session
import sh.rcn.terminus.Store

/** A page opened over the tab's home: a stop's board, or a service's line. */
sealed interface BusRoute {
    data class Stop(val code: String) : BusRoute

    /** [from]: the stop it was opened from, highlighted on the line with its time. */
    data class Line(val svc: String, val from: String?) : BusRoute
}

data class BusesUi(
    /** The stops and services, for the search and names before a board loads. */
    val campus: CampusMap? = null,
    /**
     * Boards by stop code: pinned stops, opened ones, the opposite stops. A failed refresh keeps the last one; the screen shows it
     * [Board.aged].
     */
    val boards: Map<String, Board> = emptyMap(),
    /** Stops whose board couldn't be fetched (offline), until one is. */
    val failed: Set<String> = emptySet(),
    /** Pages switched to the stop across the road, by the page's own stop. */
    val across: Set<String> = emptySet(),
    /** The pinned stops on the home's card, by code, as Nearby shows them. A failed refresh keeps the last one. */
    val pinned: Map<String, PinnedStop> = emptyMap(),
    /** Pinned stops that couldn't be fetched (offline), until one is. */
    val pinFailed: Set<String> = emptySet(),
    /** Each service's buses out, for the list of lines; empty until /api/lines answers. */
    val outs: Outs = Outs(),
    /** Lines by [lineKey]. */
    val lines: Map<String, Line> = emptyMap(),
    val lineFailed: Set<String> = emptySet(),
    /** The pages opened over the home, the top one last. */
    val stack: List<BusRoute> = emptyList(),
) {
    /** [outs] as the list shows them, merged once. */
    val out: Map<String, LineOut?> = outs.shown
}

fun lineKey(svc: String, from: String?) = "$svc|${from.orEmpty()}"

/**
 * The Stops tab. The screen drives the refreshing, only while the tab is on screen and the app in front: the page in view (on the home, the
 * pinned stop showing and its neighbours) every 15 s, the API's own cache, so asking sooner would show nothing new; on the home, each
 * service's buses out once a minute ([LinesPoll]).
 */
class BusesViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(BusesUi())
    val state: StateFlow<BusesUi> = _state

    /** When each board or line was last asked for, so going back and forth between pages doesn't ask again at once. */
    private val asked = mutableMapOf<String, Long>()

    private fun api(token: String) = Api(token)

    /**
     * A 401: this phone's token refused, so it's signed out ([Session.rejected]), and the screen follows. Nothing is asked again with it:
     * every request here first needs a token. True when [e] was that.
     */
    private suspend fun refused(e: Exception, token: String): Boolean {
        if (e !is ApiError || e.status != 401) return false
        Session.rejected(getApplication(), token)
        return true
    }

    /** How many stops the profile may pin (its `limits`). */
    var pinLimit = sh.rcn.terminus.Limits.DEFAULT.pinnedStops

    /**
     * The profile's "public buses": boards then have them too, as the web's do. A change asks again at the next refresh rather than waiting
     * out the gap.
     */
    var publicBuses = false
        set(v) {
            if (field != v) asked.clear()
            field = v
        }

    private fun fresh(key: String): Boolean = System.currentTimeMillis() - (asked[key] ?: 0) < MIN_GAP_MS

    private fun mark(key: String) {
        asked[key] = System.currentTimeMillis()
    }

    /** When each board or line last came back, for a pull sooner than [Pull.FRESH_MS] to ask nothing. */
    private val answeredAt = mutableMapOf<String, Long>()

    /** The boards and lines on their way, so a pull waits for one rather than asking twice. */
    private val asking = MutableStateFlow<Set<String>>(emptySet())

    /** [fetch] for [key], said to be on its way while it is. */
    private suspend fun fetching(key: String, fetch: suspend () -> Unit) {
        asking.update { it + key }
        try {
            fetch()
        } finally {
            asking.update { it - key }
        }
    }

    private fun answered(key: String) {
        answeredAt[key] = System.currentTimeMillis()
    }

    /**
     * Pulled down: [key] asked for again by [fetch] (the screen's own refresh), or the one already on its way waited for; nothing within
     * [Pull.FRESH_MS] of its last answer, as the server would send the same.
     */
    private suspend fun pulled(key: String, fetch: suspend () -> Unit): PullOutcome {
        val start = System.currentTimeMillis()
        when {
            key in asking.value -> asking.first { key !in it }
            Pull.shouldFetch(answeredAt[key], start) -> fetch()
            else -> return PullOutcome.UpToDate
        }
        return Pull.outcome(fetched = true, ok = (answeredAt[key] ?: 0) >= start)
    }

    /**
     * When each timed refresh next runs (BusesScreen's `Refreshing`), for a pull that asked nothing: the home's pinned stops, and the page
     * on top. Each its own, as both run at once on a wide window.
     */
    var pinsTimedAt: Long? = null
    var pageTimedAt: Long? = null

    /**
     * The stop whose page is open beside the home on a wide window, which its page asks for: the home's pinned refresh leaves it out and
     * its card takes the page's times ([PinnedStop.withBoard]). Null on a phone, where the home isn't on screen under a page.
     */
    var openStop: String? = null

    /**
     * When the timed refresh at [timedAt] brings new times for [key]: at its next run, or the one after when that's too soon after [key]
     * was last asked ([MIN_GAP_MS]) and it will skip it. Null with none due.
     */
    private fun nextUpdateAt(key: String, timedAt: Long?): Long? {
        val at = timedAt?.takeIf { it > System.currentTimeMillis() } ?: return null
        return if (at - (asked[key] ?: 0) < MIN_GAP_MS) at + BusTimes.REFRESH_MS else at
    }

    /** When new times come for the page for [code], for its pull. */
    fun pageNextAt(code: String): Long? = nextUpdateAt(pageBoard(code), pageTimedAt)

    /** When new times come for the pinned stop [code] on the home, for its pull: from its page while that's open beside it. */
    fun pinNextAt(code: String): Long? = if (code == openStop) pageNextAt(code) else nextUpdateAt(pinKey(code), pinsTimedAt)

    /** When new times come for a service's line, for its pull. */
    fun lineNextAt(svc: String, from: String?): Long? = nextUpdateAt("line:${lineKey(svc, from)}", pageTimedAt)

    /** The page for [code] pulled down. */
    suspend fun pullPage(code: String): PullOutcome = pulled(pageBoard(code)) { refreshPage(code, force = true) }

    /** The home pulled down: the pinned stop showing ([code]) asked for again, with its neighbours ([codes]); nothing with none showing. */
    suspend fun pullPinned(code: String?, codes: List<String>): PullOutcome =
        if (code == null) PullOutcome.UpToDate else pulled(pinKey(code)) { refreshPinned(codes, force = true) }

    suspend fun pullLine(svc: String, from: String?): PullOutcome =
        pulled("line:${lineKey(svc, from)}") { refreshLine(svc, from, force = true) }

    private var campusJob: kotlinx.coroutines.Job? = null

    /** The language the campus in [_state] is worded in: its lines' names and stops come from the server in it. */
    private var campusZh: Boolean? = null

    init {
        // A newer campus found in the background (a stop renamed, a line changed): the names on screen take it in place.
        viewModelScope.launch {
            MapFiles.onCampusChange({ _state.value.campus != null }, { CampusMap.parse(it).first }) { c ->
                campusZh = L.zh
                _state.update { it.copy(campus = c) }
            }
        }
    }

    fun loadCampus() {
        val zh = L.zh
        if (campusJob?.isActive == true || (_state.value.campus != null && campusZh == zh)) return
        val token = store.token ?: return
        campusJob = viewModelScope.launch {
            try {
                val json = MapFiles.campus(getApplication(), api(token)) ?: return@launch
                // Reading it takes a moment: not on the main thread.
                val c = withContext(Dispatchers.Default) { CampusMap.parse(json).first }
                campusZh = zh
                _state.update { it.copy(campus = c) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Without it, names come with the boards.
                refused(e, token)
            }
        }
    }

    suspend fun refreshBoard(code: String, force: Boolean = false) {
        if (!force && fresh(code)) return
        val token = store.token ?: return
        mark(code)
        fetching(code) {
            try {
                val board = api(token).board(code, publicBuses)
                val got = board.copy(code = board.code.ifEmpty { code }, gotMs = ServerClock.now())
                answered(code)
                _state.update { s ->
                    // A pinned stop's card takes its page's times, rather than asking for the stop again ([openStop]).
                    val pinned = s.pinned[code]?.let { s.pinned + (code to it.withBoard(got)) } ?: s.pinned
                    s.copy(boards = s.boards + (code to got), failed = s.failed - code, pinned = pinned, pinFailed = s.pinFailed - code)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (refused(e, token)) return@fetching
                _state.update { it.copy(failed = it.failed + code) }
            }
        }
    }

    /** The page for [code]: its own board, or its opposite stop's when it's switched across the road. */
    suspend fun refreshPage(code: String, force: Boolean = false) = refreshBoard(pageBoard(code), force)

    /** The page of the home's card showing, by its stop's code ([PinPages]); null for the first. Kept while the app runs. */
    var pinShown: String? = null

    /** The pins the card was last laid out for, for [PinPages.kept]. */
    private var pinsBefore: List<String> = emptyList()

    /** The page to show for [pins], the one showing kept through a change to them ([PinPages.kept]). */
    fun pinPage(pins: List<String>): Int {
        if (pins != pinsBefore) {
            pinShown = PinPages.kept(pinsBefore, pins, pinShown)
            pinsBefore = pins
        }
        return PinPages.index(pins, pinShown)
    }

    /**
     * The pinned stops [codes] from /api/me/stops, in one request: those not asked for in the last [MIN_GAP_MS], or all of them when
     * [force]d. With a location this phone already has, each says the walk there.
     */
    suspend fun refreshPinned(codes: List<String>, force: Boolean = false) {
        val ask =
            if (force) codes.distinct()
            else
                PinPages.due(
                    codes,
                    { asked[pinKey(it)] },
                    System.currentTimeMillis(),
                    MIN_GAP_MS,
                    // Left to its page while the card's own answer is fresh; then asked once, for its guesses after the board's buses.
                    openStop?.takeIf { _state.value.pinned[it]?.answerFresh(ServerClock.now()) == true },
                )
        if (ask.isEmpty()) return
        val token = store.token ?: return
        val keys = ask.map(::pinKey)
        keys.forEach(::mark)
        lastPinned = ask
        asking.update { it + keys }
        try {
            val loc = location()
            val (stops, _) = api(token).stops(ask, loc?.latitude, loc?.longitude)
            val got = ServerClock.now()
            keys.forEach(::answered)
            // Keyed by the code asked for, whatever case the server writes it in; one it doesn't know is one it couldn't get.
            val byCode =
                ask.mapNotNull { code ->
                        stops.firstOrNull { it.code.equals(code, ignoreCase = true) }?.let { code to PinnedStop(it, got) }
                    }
                    .toMap()
            _state.update { s -> s.copy(pinned = s.pinned + byCode, pinFailed = s.pinFailed - byCode.keys + (ask - byCode.keys)) }
        } catch (e: CancellationException) {
            // Not asked after all (the page moved on mid-request): due again at once, rather than "Checking…" until the next refresh.
            keys.forEach { asked.remove(it) }
            throw e
        } catch (e: Exception) {
            if (refused(e, token)) return
            _state.update { it.copy(pinFailed = it.pinFailed + ask) }
        } finally {
            asking.update { it - keys.toSet() }
        }
    }

    private fun pinKey(code: String) = "pin:$code"

    /** The stops the last [refreshPinned] asked for, asked again once a location comes. */
    private var lastPinned: List<String> = emptyList()

    private var fixing: kotlinx.coroutines.Job? = null

    /**
     * Where the phone is, for the walk to each pinned stop: a fix it already has (up to 10 minutes old), never a permission asked for. With
     * the permission and no such fix, a new one is asked for, once, and the stops asked for again when it comes.
     */
    private fun location(): android.location.Location? {
        val ctx = getApplication<Application>()
        Locator.lastKnown(ctx)?.let {
            return it
        }
        if (fixing == null && Locator.hasForeground(ctx)) {
            fixing = viewModelScope.launch {
                if (Locator.fresh(ctx) != null && lastPinned.isNotEmpty()) refreshPinned(lastPinned, force = true)
            }
        }
        return null
    }

    /** When /api/lines was last asked, for [LinesPoll]. */
    private var linesAskedAt: Long? = null

    /** How long until the list of lines may ask for its buses out again. */
    fun linesWaitMs(): Long = LinesPoll.waitMs(linesAskedAt, System.currentTimeMillis())

    /** How long the list of lines sleeps before it tries again ([LinesPoll.nextMs]). */
    fun linesNextMs(): Long = LinesPoll.nextMs(linesAskedAt, System.currentTimeMillis())

    /** Each service's buses out, when [LinesPoll] allows: a failure says nothing rather than an old count, and waits out the minute too. */
    suspend fun refreshLines() {
        if (linesWaitMs() > 0) return
        val token = store.token ?: return
        linesAskedAt = System.currentTimeMillis()
        try {
            val (lines, asOfMs) = api(token).lines()
            _state.update { it.copy(outs = it.outs.listed(lines, asOfMs ?: ServerClock.now())) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (refused(e, token)) return
            _state.update { it.copy(outs = it.outs.listed(emptyMap(), 0)) }
        }
    }

    /** The board the page for [code] shows: its own, or its opposite stop's. */
    private fun pageBoard(code: String): String {
        val s = _state.value
        val opposite = s.boards[code]?.opposite
        return if (code in s.across && opposite != null) opposite else code
    }

    suspend fun refreshLine(svc: String, from: String?, force: Boolean = false) {
        val key = lineKey(svc, from)
        if (!force && fresh("line:$key")) return
        val token = store.token ?: return
        mark("line:$key")
        fetching("line:$key") { line(token, svc, from, key) }
    }

    private suspend fun line(token: String, svc: String, from: String?, key: String) {
        try {
            got(key, svc, api(token).line(svc, from).copy(gotMs = ServerClock.now()))
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (refused(e, token)) return
            // The stop isn't on this service (a 400): the line without it; worked out here for an older server.
            if (from != null && e.status == 400) {
                try {
                    got(key, svc, api(token).line(svc).copy(gotMs = ServerClock.now()))
                    return
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {}
            }
            _state.update { it.copy(lineFailed = it.lineFailed + key) }
        } catch (e: Exception) {
            _state.update { it.copy(lineFailed = it.lineFailed + key) }
        }
    }

    /** A line come in: shown, and its count taken into the list of lines, which is older ([Outs]). */
    private fun got(key: String, svc: String, line: Line) {
        answered("line:$key")
        _state.update {
            it.copy(
                lines = it.lines + (key to line),
                lineFailed = it.lineFailed - key,
                // When it came: the line's asOf can be pulled back by an old stop row.
                outs = it.outs.paged(svc, line.out, line.gotMs ?: ServerClock.now()),
            )
        }
    }

    /** This side or across the road, for the page of stop [code]. */
    fun setAcross(code: String, across: Boolean) {
        _state.update { it.copy(across = if (across) it.across + code else it.across - code) }
        viewModelScope.launch {
            val opposite = _state.value.boards[code]?.opposite ?: return@launch
            refreshBoard(if (across) opposite else code)
        }
    }

    fun open(route: BusRoute) = _state.update { it.copy(stack = it.stack + route) }

    /** [route] opened from the tab's home: the first page over it, in place of whatever was open (wide, the one beside the list). */
    fun show(route: BusRoute) = _state.update { it.copy(stack = listOf(route)) }

    fun back() = _state.update { it.copy(stack = it.stack.dropLast(1)) }

    /** The tab tapped again: back to its home. */
    fun home() = _state.update { it.copy(stack = emptyList()) }

    private companion object {
        /** Shorter than the refresh, so the 15 s tick always asks; longer than a quick back and forth. */
        const val MIN_GAP_MS = 10_000L
    }
}
