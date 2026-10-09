package sh.rcn.terminus.ui

import android.app.Application
import android.os.SystemClock
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.Board
import sh.rcn.terminus.CampusMap
import sh.rcn.terminus.LiveBus
import sh.rcn.terminus.Locator
import sh.rcn.terminus.MapFiles
import sh.rcn.terminus.MapGeoJson
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.Session
import sh.rcn.terminus.Store

/** What the pill's status line says about the live buses. */
sealed interface BusStatus {
    data object Finding : BusStatus
    data class Running(val count: Int) : BusStatus
    data object NoneRunning : BusStatus
    data object Unavailable : BusStatus
}

/** The sheet over the bottom of the map: a stop, or a bus. */
sealed interface MapSheet {
    /** [from]: the bus whose stops it was opened from, which back returns to. */
    data class Stop(val code: String, val from: Bus? = null) : MapSheet
    /** [stops]: its stops ahead open, and [all] of them, as when it's come back to from one of them. */
    data class Bus(val id: String, val stops: Boolean = false, val all: Boolean = false) : MapSheet
}

data class MapUi(
    val campus: CampusMap? = null,
    /** Codes of the main campus's stops, for the first view. */
    val core: Set<String> = emptySet(),
    /** The route lines and the stops as GeoJSON, made with [campus], off the main thread. */
    val routesJson: String = MapGeoJson.EMPTY,
    val stopsJson: String = MapGeoJson.EMPTY,
    /** The style JSON for the current theme and language. */
    val style: String? = null,
    /** Nothing to show: no connection the first time. */
    val failed: Boolean = false,
    /** The service whose pill is on. */
    val selected: String? = null,
    val buses: List<LiveBus> = emptyList(),
    /** The buses are where they were last seen, the feed being down: shown dimmed, and said so. */
    val busesStale: Boolean = false,
    /** Counts every answer from /buses, the same list or not, so the slides are planned again each time. */
    val busAnswers: Int = 0,
    val busStatus: BusStatus? = null,
    val sheet: MapSheet? = null,
    /** A stop opened from elsewhere (Nearby on Now), for the map to move to once. */
    val focus: String? = null,
    /** A bus come back to from one of its stops, for the map to move back to once. */
    val focusBus: String? = null,
    /** The open stop's board, the services not running now too; null while it loads. */
    val board: Board? = null,
    /** True when the board couldn't be fetched at all (offline). */
    val boardFailed: Boolean = false,
    /** True when the server answered, but not with the board (down, or busy). */
    val boardError: Boolean = false,
    /** Where the phone is, only with location already allowed. */
    val me: Pair<Double, Double>? = null,
    /** The street map file is downloading (the first open): the map is plain until it's here. */
    val downloading: Boolean = false,
    /** The download failed: routes and stops only, until the next try. */
    val downloadFailed: Boolean = false,
)

/** Buses from a poll this old, with none since, are drawn faded: three missed 5 s polls. */
private const val BUSES_OLD_MS = 15_000L

/**
 * The Map tab. The screen drives the polling (only while it's on screen):
 * [refreshBuses] every 5 s while a pill is on, [refreshBoard] every 15 s
 * while a stop's sheet is open, [locate] now and then.
 */
class MapViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(MapUi())
    val state: StateFlow<MapUi> = _state

    /** The theme and language of the style shown or being fetched; null: none yet, or the last try got nothing. */
    private var styleKey: Pair<Boolean, Boolean>? = null
    private var styleJob: Job? = null
    private var campusJob: Job? = null
    private var tilesJob: Job? = null
    private var styleFailed = false
    private var campusFailed = false

    /** When /buses last answered (elapsedRealtime, which counts on in sleep), to tell when the buses shown are old. */
    private var busesAt = 0L

    private fun api(token: String?) = Api(token)

    /** The profile's "public buses": a stop's sheet has them too, as its Buses tab board does. */
    var publicBuses = false

    /** Nothing to draw the map with: no stops and routes, or no style, and the last try for it failed. */
    private fun failed(s: MapUi) = (s.campus == null && campusFailed) || (s.style == null && styleFailed)

    /**
     * The stops, routes and style; again when the theme or language changes,
     * and whatever didn't come last time. Nothing already on its way is
     * asked for twice.
     */
    fun open(dark: Boolean, zh: Boolean) {
        val ctx = getApplication<Application>()
        val key = dark to zh
        if (styleKey != key || (_state.value.style == null && styleJob?.isActive != true)) {
            styleKey = key
            styleJob?.cancel()
            styleJob = viewModelScope.launch {
                val style = MapFiles.style(ctx, dark, zh)
                styleFailed = style == null
                // Nothing came: the next open asks again, rather than the map waiting on it for good.
                if (style == null && styleKey == key) styleKey = null
                _state.update { s -> s.copy(style = style ?: s.style).let { it.copy(failed = failed(it)) } }
            }
        }
        if (_state.value.campus == null && campusJob?.isActive != true) {
            campusJob = viewModelScope.launch {
                val token = store.token
                try {
                    val json = MapFiles.campus(ctx, api(token))
                    campusFailed = json == null
                    if (json == null) {
                        _state.update { it.copy(failed = failed(it)) }
                    } else {
                        // Reading it and making the GeoJSON takes a moment: not on the main thread.
                        val (campus, core, lines) = withContext(Dispatchers.Default) {
                            val (campus, core) = CampusMap.parse(json)
                            Triple(campus, core, MapGeoJson.routes(campus) to MapGeoJson.stops(campus))
                        }
                        _state.update { s -> s.copy(campus = campus, core = core, routesJson = lines.first, stopsJson = lines.second).let { it.copy(failed = failed(it)) } }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    if (e is ApiError && e.status == 401) Session.rejected(ctx, token)
                    campusFailed = true
                    _state.update { it.copy(failed = failed(it)) }
                }
            }
        }
        // The whole map file for offline, in the background. The first
        // time, the map is plain until it's here; then the streets appear.
        // After a failed try, the next open tries again.
        if ((_state.value.campus == null || _state.value.downloadFailed) && tilesJob?.isActive != true) {
            tilesJob = viewModelScope.launch {
                val before = MapFiles.tilesPath(ctx)
                if (before == null) _state.update { it.copy(downloading = true, downloadFailed = false) }
                val after = MapFiles.keepTiles(ctx)
                _state.update { it.copy(downloading = false, downloadFailed = after == null) }
                // A new file, the first or a newer version under a name of its own: the style points at it.
                val shown = styleKey
                if (after != null && after != before && shown != null) {
                    MapFiles.style(ctx, shown.first, shown.second)?.let { style -> _state.update { it.copy(style = style) } }
                }
            }
        }
    }

    /** One pill at a time; the same one again turns it off. */
    /** A service from the Buses tab: its pill on, never toggled off. */
    fun show(svc: String) {
        if (_state.value.selected != svc) choose(svc)
    }

    fun choose(svc: String?) {
        val next = if (svc == _state.value.selected) null else svc
        _state.update { it.copy(selected = next, buses = emptyList(), busesStale = false, busStatus = if (next == null) null else BusStatus.Finding, sheet = (it.sheet as? MapSheet.Stop)) }
    }

    suspend fun refreshBuses() {
        val svc = _state.value.selected ?: return
        // Signed out (a 401 below): nothing to ask with.
        val token = store.token ?: return
        try {
            val list = api(token).buses(svc)
            if (svc != _state.value.selected) return
            val status = when {
                !list.available -> BusStatus.Unavailable
                list.buses.isEmpty() -> BusStatus.NoneRunning
                else -> BusStatus.Running(list.buses.size)
            }
            busesAt = SystemClock.elapsedRealtime()
            _state.update { s ->
                // A bus whose card is open and has gone: close the card.
                val sheet = s.sheet.let { sh -> if (sh is MapSheet.Bus && list.buses.none { it.id == sh.id }) null else sh }
                s.copy(buses = list.buses, busesStale = list.stale && list.buses.isNotEmpty(), busAnswers = s.busAnswers + 1, busStatus = status, sheet = sheet)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ApiError && e.status == 401) {
                Session.rejected(getApplication(), token)
                return
            }
            // No answer: the buses stay where they were last seen, faded once
            // that's a few polls ago, as when the feed itself is down.
            val old = SystemClock.elapsedRealtime() - busesAt > BUSES_OLD_MS
            if (svc == _state.value.selected) _state.update { it.copy(busStatus = BusStatus.Unavailable, busesStale = it.busesStale || (old && it.buses.isNotEmpty())) }
        }
    }

    fun openStop(code: String) = _state.update { it.copy(sheet = MapSheet.Stop(code), board = null, boardFailed = false, boardError = false) }

    /**
     * A stop from Nearby, or from a bus's sheet ([from], which back returns
     * to): its sheet, and the map moved to it. Unknown codes are ignored.
     */
    fun showStop(code: String, from: MapSheet.Bus? = null) = _state.update {
        if (it.campus != null && it.campus.stop(code) == null) it
        else it.copy(sheet = MapSheet.Stop(code, from), board = null, boardFailed = false, boardError = false, focus = code, focusBus = null)
    }

    fun openBus(id: String) = _state.update { it.copy(sheet = MapSheet.Bus(id)) }

    fun closeSheet() = _state.update { it.copy(sheet = null, board = null, focus = null, focusBus = null) }

    /** Back: from a stop opened from a bus, to that bus if it's still on the map; else closed. */
    fun back() = _state.update { s ->
        val from = (s.sheet as? MapSheet.Stop)?.from?.takeIf { b -> s.buses.any { it.id == b.id } }
        if (from != null) s.copy(sheet = from, board = null, focus = null, focusBus = from.id) else s.copy(sheet = null, board = null, focus = null, focusBus = null)
    }

    private val _home = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    /** Each tap of the Map tab while on it, for the map to frame the whole campus again. */
    val homeTaps: SharedFlow<Unit> = _home

    /** The Map tab tapped while on it: back to how it opened, no pill on and no sheet open. */
    fun home() {
        _state.update { it.copy(selected = null, buses = emptyList(), busesStale = false, busStatus = null, sheet = null, board = null, focus = null, focusBus = null) }
        _home.tryEmit(Unit)
    }

    suspend fun refreshBoard() {
        val code = (_state.value.sheet as? MapSheet.Stop)?.code ?: return
        val token = store.token ?: return
        fun open() = (_state.value.sheet as? MapSheet.Stop)?.code == code
        try {
            val board = api(token).board(code, publicBuses)
            if (open()) _state.update { it.copy(board = board, boardFailed = false, boardError = false) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            when (e.status) {
                401 -> Session.rejected(getApplication(), token)
                // A stop the server doesn't know: no times, which is true.
                404 -> if (open()) _state.update { it.copy(board = Board(code, "", null, false, emptyList(), null), boardFailed = false, boardError = false) }
                // Down or busy: not "no times", which would say no buses are coming.
                else -> if (open()) _state.update { it.copy(boardError = true, boardFailed = false) }
            }
        } catch (e: ParseError) {
            if (open()) _state.update { it.copy(boardError = true, boardFailed = false) }
        } catch (e: Exception) {
            if (open()) _state.update { it.copy(boardFailed = true, boardError = false) }
        }
    }

    /** Your dot. Never asks for location: only with it already allowed. */
    suspend fun locate() {
        val ctx = getApplication<Application>()
        if (!Locator.hasForeground(ctx)) return
        val at = Locator.current(ctx) ?: return
        _state.update { it.copy(me = at.latitude to at.longitude) }
    }
}
