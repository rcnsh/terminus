package sh.rcn.terminus.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
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
import sh.rcn.terminus.Line
import sh.rcn.terminus.MapFiles
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
    /** Lines by [lineKey]. */
    val lines: Map<String, Line> = emptyMap(),
    val lineFailed: Set<String> = emptySet(),
    /** The pages opened over the home, the top one last. */
    val stack: List<BusRoute> = emptyList(),
)

fun lineKey(svc: String, from: String?) = "$svc|${from.orEmpty()}"

/**
 * The Stops tab. The screen drives the refreshing, only while the tab is on screen and the app in front: the page in view (on the home,
 * every pinned stop's board) every 15 s, the API's own cache, so asking sooner would show nothing new.
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

    /** When the screen's timed refresh next runs (BusesScreen's `Refreshing`), for a pull that asked nothing. */
    var nextTimedAt: Long? = null

    /**
     * When the timed refresh brings new times for [key]: at its next run, or the one after when that's too soon after [key] was last asked
     * ([MIN_GAP_MS]) and it will skip it. Null with none due.
     */
    private fun nextUpdateAt(key: String): Long? {
        val at = nextTimedAt?.takeIf { it > System.currentTimeMillis() } ?: return null
        return if (at - (asked[key] ?: 0) < MIN_GAP_MS) at + BusTimes.REFRESH_MS else at
    }

    /** When new times come for the page for [code], for its pull. */
    fun pageNextAt(code: String): Long? = nextUpdateAt(pageBoard(code))

    /** When new times come for the home's pinned stops [codes], for its pull: the soonest of theirs. */
    fun homeNextAt(codes: List<String>): Long? = codes.mapNotNull(::nextUpdateAt).minOrNull()

    /** When new times come for a service's line, for its pull. */
    fun lineNextAt(svc: String, from: String?): Long? = nextUpdateAt("line:${lineKey(svc, from)}")

    /** The page for [code] pulled down. */
    suspend fun pullPage(code: String): PullOutcome = pulled(pageBoard(code)) { refreshPage(code, force = true) }

    /** The home pulled down: each pinned stop's board, together; updated if any came back, failed if none did and one was asked. */
    suspend fun pullHome(codes: List<String>): PullOutcome {
        if (codes.isEmpty()) return PullOutcome.UpToDate
        val outcomes = coroutineScope { codes.map { code -> async { pulled(code) { refreshBoard(code, force = true) } } }.awaitAll() }
        return when {
            PullOutcome.Updated in outcomes -> PullOutcome.Updated
            PullOutcome.Failed in outcomes -> PullOutcome.Failed
            else -> PullOutcome.UpToDate
        }
    }

    suspend fun pullLine(svc: String, from: String?): PullOutcome =
        pulled("line:${lineKey(svc, from)}") { refreshLine(svc, from, force = true) }

    private var campusJob: kotlinx.coroutines.Job? = null

    fun loadCampus() {
        if (_state.value.campus != null || campusJob?.isActive == true) return
        val token = store.token ?: return
        campusJob = viewModelScope.launch {
            try {
                val json = MapFiles.campus(getApplication(), api(token)) ?: return@launch
                // Reading it takes a moment: not on the main thread.
                val c = withContext(Dispatchers.Default) { CampusMap.parse(json).first }
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
                _state.update { it.copy(boards = it.boards + (code to got), failed = it.failed - code) }
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

    /**
     * The home's pinned stops [codes] (at most the pin limit, [Pins.shown]), together: their own boards, as the home shows no opposite
     * stop.
     */
    suspend fun refreshHome(codes: List<String>) = coroutineScope { for (code in codes) launch { refreshBoard(code) } }

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
            val line = api(token).line(svc, from).copy(gotMs = ServerClock.now())
            answered("line:$key")
            _state.update { it.copy(lines = it.lines + (key to line), lineFailed = it.lineFailed - key) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (refused(e, token)) return
            // The stop isn't on this service (a 400): the line without it; worked out here for an older server.
            if (from != null && e.status == 400) {
                try {
                    val line = api(token).line(svc).copy(gotMs = ServerClock.now())
                    answered("line:$key")
                    _state.update { it.copy(lines = it.lines + (key to line), lineFailed = it.lineFailed - key) }
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

    /** This side or across the road, for the page of stop [code]. */
    fun setAcross(code: String, across: Boolean) {
        _state.update { it.copy(across = if (across) it.across + code else it.across - code) }
        viewModelScope.launch {
            val opposite = _state.value.boards[code]?.opposite ?: return@launch
            refreshBoard(if (across) opposite else code)
        }
    }

    fun open(route: BusRoute) = _state.update { it.copy(stack = it.stack + route) }

    fun back() = _state.update { it.copy(stack = it.stack.dropLast(1)) }

    /** The tab tapped again: back to its home. */
    fun home() = _state.update { it.copy(stack = emptyList()) }

    private companion object {
        /** Shorter than the refresh, so the 15 s tick always asks; longer than a quick back and forth. */
        const val MIN_GAP_MS = 10_000L
    }
}
