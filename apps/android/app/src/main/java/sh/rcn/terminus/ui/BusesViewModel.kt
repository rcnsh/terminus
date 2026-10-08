package sh.rcn.terminus.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.Board
import sh.rcn.terminus.CampusMap
import sh.rcn.terminus.Line
import sh.rcn.terminus.Locator
import sh.rcn.terminus.MapFiles
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Session
import sh.rcn.terminus.Store
import sh.rcn.terminus.parseInstant
import sh.rcn.terminus.parseNearby

/** A page opened over the tab's home: a stop's board, or a service's line. */
sealed interface BusRoute {
    data class Stop(val code: String) : BusRoute
    /** [from]: the stop it was opened from, highlighted on the line with its time. */
    data class Line(val svc: String, val from: String?) : BusRoute
}

/** Where the nearest stop's page is. */
enum class Nearest { Loading, Ready, None, Failed }

data class BusesUi(
    /** The stops and services, for the search and names before a board loads. */
    val campus: CampusMap? = null,
    val nearest: Board? = null,
    val nearestState: Nearest = Nearest.Loading,
    /** The nearest stop is from a location; false: from the home stop. */
    val located: Boolean = false,
    /**
     * Boards by stop code: pinned stops, opened ones, the twins across the road.
     * A failed refresh keeps the last one; the screen shows it [Board.aged].
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
 * The Buses tab. The screen drives the refreshing, only while the tab is on
 * screen and the app in front: the page in view every 15 s, the API's own
 * cache, so asking sooner would show nothing new.
 */
class BusesViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(BusesUi())
    val state: StateFlow<BusesUi> = _state

    /** When each board or line was last asked for, so swiping back and forth doesn't ask again at once. */
    private val asked = mutableMapOf<String, Long>()

    private fun api(token: String) = Api(token)

    /**
     * A 401: this phone's token refused, so it's signed out
     * ([Session.rejected]), and the screen follows. Nothing is asked again
     * with it: every request here first needs a token. True when [e] was that.
     */
    private suspend fun refused(e: Exception, token: String): Boolean {
        if (e !is ApiError || e.status != 401) return false
        Session.rejected(getApplication(), token)
        return true
    }

    /**
     * The profile's "public buses": boards then have them too, as the web's
     * do. A change asks again at the next refresh rather than waiting out the gap.
     */
    /** How many stops the profile may pin (its `limits`). */
    var pinLimit = sh.rcn.terminus.Limits.DEFAULT.pinnedStops

    var publicBuses = false
        set(v) {
            if (field != v) asked.clear()
            field = v
        }

    private fun fresh(key: String): Boolean = System.currentTimeMillis() - (asked[key] ?: 0) < MIN_GAP_MS

    private fun mark(key: String) { asked[key] = System.currentTimeMillis() }

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

    /** The nearest stop, by location, else the home stop; its twin across the road comes with it. */
    suspend fun refreshNearest(force: Boolean = false) {
        if (!force && fresh(NEAREST)) return
        val token = store.token ?: return
        mark(NEAREST)
        val ctx = getApplication<Application>()
        val loc = Locator.lastKnown(ctx, maxAgeMs = 60_000) ?: Locator.current(ctx)
        try {
            val json = api(token).nearbyJson(loc?.latitude, loc?.longitude, Locator.accOf(loc), stopped = true)
            val asOf = json.optString("asOf").takeIf { it.isNotEmpty() }?.let(::parseInstant)
            val got = ServerClock.now()
            val stops = parseNearby(json).map { Board.of(it, asOf).copy(gotMs = got) }
            val first = stops.firstOrNull()
            _state.update { s ->
                s.copy(
                    nearest = first,
                    nearestState = if (first == null) Nearest.None else Nearest.Ready,
                    located = loc != null,
                    boards = s.boards + stops.associateBy { it.code },
                    failed = s.failed - stops.map { it.code }.toSet(),
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (refused(e, token)) return
            // No location and no home stop: nothing to call nearest.
            _state.update { it.copy(nearest = null, nearestState = if (e.status == 400) Nearest.None else Nearest.Failed) }
        } catch (e: Exception) {
            _state.update { it.copy(nearestState = if (it.nearest == null) Nearest.Failed else it.nearestState) }
        }
    }

    suspend fun refreshBoard(code: String, force: Boolean = false) {
        if (!force && fresh(code)) return
        val token = store.token ?: return
        mark(code)
        try {
            val board = api(token).board(code, publicBuses)
            val got = board.copy(code = board.code.ifEmpty { code }, gotMs = ServerClock.now())
            _state.update { it.copy(boards = it.boards + (code to got), failed = it.failed - code) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (refused(e, token)) return
            _state.update { it.copy(failed = it.failed + code) }
        }
    }

    /**
     * The page for [code] (null: the nearest stop): its own board, or its
     * twin's when it's switched across the road. The nearest stop's twin
     * comes with /me/nearby, so that page asks only for that.
     */
    suspend fun refreshPage(code: String?) {
        val s = _state.value
        val own = code ?: s.nearest?.code
        if (code == null || own == null) {
            refreshNearest()
            return
        }
        val opposite = s.boards[own]?.opposite
        if (own in s.across && opposite != null) refreshBoard(opposite) else refreshBoard(own)
    }

    suspend fun refreshLine(svc: String, from: String?, force: Boolean = false) {
        val key = lineKey(svc, from)
        if (!force && fresh("line:$key")) return
        val token = store.token ?: return
        mark("line:$key")
        try {
            val line = api(token).line(svc, from).copy(gotMs = ServerClock.now())
            _state.update { it.copy(lines = it.lines + (key to line), lineFailed = it.lineFailed - key) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if (refused(e, token)) return
            // The stop isn't on this service (or an older server without /line): the line without it.
            if (from != null && e.status == 400) {
                try {
                    val line = api(token).line(svc).copy(gotMs = ServerClock.now())
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
        const val NEAREST = "nearest"
        /** Shorter than the refresh, so the 15 s tick always asks; longer than a swipe back. */
        const val MIN_GAP_MS = 10_000L
    }
}
