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

sealed interface BusRoute {
    data class Stop(val code: String) : BusRoute

    data class Line(val svc: String, val from: String?) : BusRoute
}

data class BusesUi(
    val campus: CampusMap? = null,
    val boards: Map<String, Board> = emptyMap(),
    val failed: Set<String> = emptySet(),
    val across: Set<String> = emptySet(),
    val pinned: Map<String, PinnedStop> = emptyMap(),
    val pinFailed: Set<String> = emptySet(),
    val outs: Outs = Outs(),
    val lines: Map<String, Line> = emptyMap(),
    val lineFailed: Set<String> = emptySet(),
    val stack: List<BusRoute> = emptyList(),
) {
    val out: Map<String, LineOut?> = outs.shown
}

fun lineKey(svc: String, from: String?) = "$svc|${from.orEmpty()}"

class BusesViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(BusesUi())
    val state: StateFlow<BusesUi> = _state

    private val asked = mutableMapOf<String, Long>()

    private fun api(token: String) = Api(token)

    private suspend fun refused(e: Exception, token: String): Boolean {
        if (e !is ApiError || e.status != 401) return false
        Session.rejected(getApplication(), token)
        return true
    }

    var pinLimit = sh.rcn.terminus.Limits.DEFAULT.pinnedStops

    var publicBuses = false
        set(v) {
            if (field != v) asked.clear()
            field = v
        }

    private fun fresh(key: String): Boolean = System.currentTimeMillis() - (asked[key] ?: 0) < MIN_GAP_MS

    private fun mark(key: String) {
        asked[key] = System.currentTimeMillis()
    }

    private val answeredAt = mutableMapOf<String, Long>()

    private val asking = MutableStateFlow<Set<String>>(emptySet())

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

    private suspend fun pulled(key: String, fetch: suspend () -> Unit): PullOutcome {
        val start = System.currentTimeMillis()
        when {
            key in asking.value -> asking.first { key !in it }
            Pull.shouldFetch(answeredAt[key], start) -> fetch()
            else -> return PullOutcome.UpToDate
        }
        return Pull.outcome(fetched = true, ok = (answeredAt[key] ?: 0) >= start)
    }

    var pinsTimedAt: Long? = null
    var pageTimedAt: Long? = null

    var openStop: String? = null

    private fun nextUpdateAt(key: String, timedAt: Long?): Long? {
        val at = timedAt?.takeIf { it > System.currentTimeMillis() } ?: return null
        return if (at - (asked[key] ?: 0) < MIN_GAP_MS) at + BusTimes.REFRESH_MS else at
    }

    fun pageNextAt(code: String): Long? = nextUpdateAt(pageBoard(code), pageTimedAt)

    fun pinNextAt(code: String): Long? = if (code == openStop) pageNextAt(code) else nextUpdateAt(pinKey(code), pinsTimedAt)

    fun lineNextAt(svc: String, from: String?): Long? = nextUpdateAt("line:${lineKey(svc, from)}", pageTimedAt)

    suspend fun pullPage(code: String): PullOutcome = pulled(pageBoard(code)) { refreshPage(code, force = true) }

    suspend fun pullPinned(code: String?, codes: List<String>): PullOutcome =
        if (code == null) PullOutcome.UpToDate else pulled(pinKey(code)) { refreshPinned(codes, force = true) }

    suspend fun pullLine(svc: String, from: String?): PullOutcome =
        pulled("line:${lineKey(svc, from)}") { refreshLine(svc, from, force = true) }

    private var campusJob: kotlinx.coroutines.Job? = null

    private var campusZh: Boolean? = null

    init {
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
                val c = withContext(Dispatchers.Default) { CampusMap.parse(json).first }
                campusZh = zh
                _state.update { it.copy(campus = c) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
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

    suspend fun refreshPage(code: String, force: Boolean = false) = refreshBoard(pageBoard(code), force)

    var pinShown: String? = null

    private var pinsBefore: List<String> = emptyList()

    fun pinPage(pins: List<String>): Int {
        if (pins != pinsBefore) {
            pinShown = PinPages.kept(pinsBefore, pins, pinShown)
            pinsBefore = pins
        }
        return PinPages.index(pins, pinShown)
    }

    suspend fun refreshPinned(codes: List<String>, force: Boolean = false) {
        val ask =
            if (force) codes.distinct()
            else
                PinPages.due(
                    codes,
                    { asked[pinKey(it)] },
                    System.currentTimeMillis(),
                    MIN_GAP_MS,
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
            val byCode =
                ask.mapNotNull { code ->
                        stops.firstOrNull { it.code.equals(code, ignoreCase = true) }?.let { code to PinnedStop(it, got) }
                    }
                    .toMap()
            _state.update { s -> s.copy(pinned = s.pinned + byCode, pinFailed = s.pinFailed - byCode.keys + (ask - byCode.keys)) }
        } catch (e: CancellationException) {
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

    private var lastPinned: List<String> = emptyList()

    private var fixing: kotlinx.coroutines.Job? = null

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

    private var linesAskedAt: Long? = null

    fun linesWaitMs(): Long = LinesPoll.waitMs(linesAskedAt, System.currentTimeMillis())

    fun linesNextMs(): Long = LinesPoll.nextMs(linesAskedAt, System.currentTimeMillis())

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

    private fun got(key: String, svc: String, line: Line) {
        answered("line:$key")
        _state.update {
            it.copy(
                lines = it.lines + (key to line),
                lineFailed = it.lineFailed - key,
                outs = it.outs.paged(svc, line.out, line.gotMs ?: ServerClock.now()),
            )
        }
    }

    fun setAcross(code: String, across: Boolean) {
        _state.update { it.copy(across = if (across) it.across + code else it.across - code) }
        viewModelScope.launch {
            val opposite = _state.value.boards[code]?.opposite ?: return@launch
            refreshBoard(if (across) opposite else code)
        }
    }

    fun open(route: BusRoute) = _state.update { it.copy(stack = it.stack + route) }

    fun show(route: BusRoute) = _state.update { it.copy(stack = listOf(route)) }

    fun back() = _state.update { it.copy(stack = it.stack.dropLast(1)) }

    fun home() = _state.update { it.copy(stack = emptyList()) }

    private companion object {
        const val MIN_GAP_MS = 10_000L
    }
}
