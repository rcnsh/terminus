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
import org.json.JSONObject
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

sealed interface BusStatus {
    data object Finding : BusStatus

    data class Running(val count: Int) : BusStatus

    data object NoneRunning : BusStatus

    data object Unavailable : BusStatus
}

sealed interface MapSheet {
    data class Stop(val code: String, val from: Bus? = null) : MapSheet

    data class Bus(val id: String, val stops: Boolean = false, val all: Boolean = false) : MapSheet
}

data class MapUi(
    val campus: CampusMap? = null,
    val core: Set<String> = emptySet(),
    val routesJson: String = MapGeoJson.EMPTY,
    val stopsJson: String = MapGeoJson.EMPTY,
    val style: String? = null,
    val failed: Boolean = false,
    val selected: String? = null,
    val buses: List<LiveBus> = emptyList(),
    val busesStale: Boolean = false,
    val busAnswers: Int = 0,
    val busStatus: BusStatus? = null,
    val sheet: MapSheet? = null,
    val focus: String? = null,
    val focusBus: String? = null,
    val board: Board? = null,
    val boardFailed: Boolean = false,
    val boardError: Boolean = false,
    val me: Pair<Double, Double>? = null,
    val downloading: Boolean = false,
    val downloadFailed: Boolean = false,
)

private const val BUSES_OLD_MS = 15_000L

class MapViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(MapUi())
    val state: StateFlow<MapUi> = _state

    private var styleKey: Pair<Boolean, Boolean>? = null
    private var styleJob: Job? = null
    private var campusJob: Job? = null
    private var tilesJob: Job? = null
    private var styleFailed = false
    private var campusFailed = false

    private var busesAt = 0L

    private fun api(token: String?) = Api(token)

    var publicBuses = false

    init {
        viewModelScope.launch {
            MapFiles.onCampusChange({ _state.value.campus != null }, ::readCampus, ::showCampus)
        }
    }

    private fun readCampus(json: JSONObject): Triple<CampusMap, Set<String>, Pair<String, String>> {
        val (campus, core) = CampusMap.parse(json)
        return Triple(campus, core, MapGeoJson.routes(campus) to MapGeoJson.stops(campus))
    }

    private fun showCampus(read: Triple<CampusMap, Set<String>, Pair<String, String>>) {
        val (campus, core, lines) = read
        _state.update { s ->
            s.copy(campus = campus, core = core, routesJson = lines.first, stopsJson = lines.second).let { it.copy(failed = failed(it)) }
        }
    }

    private fun failed(s: MapUi) = (s.campus == null && campusFailed) || (s.style == null && styleFailed)

    fun open(dark: Boolean, zh: Boolean) {
        val ctx = getApplication<Application>()
        val key = dark to zh
        if (styleKey != key || (_state.value.style == null && styleJob?.isActive != true)) {
            styleKey = key
            styleJob?.cancel()
            styleJob = viewModelScope.launch {
                val style = MapFiles.style(ctx, dark, zh)
                styleFailed = style == null
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
                        showCampus(withContext(Dispatchers.Default) { readCampus(json) })
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
        if ((_state.value.campus == null || _state.value.downloadFailed) && tilesJob?.isActive != true) {
            tilesJob = viewModelScope.launch {
                val before = MapFiles.tilesPath(ctx)
                if (before == null) _state.update { it.copy(downloading = true, downloadFailed = false) }
                val after = MapFiles.keepTiles(ctx)
                _state.update { it.copy(downloading = false, downloadFailed = after == null) }
                val shown = styleKey
                if (after != null && after != before && shown != null) {
                    MapFiles.style(ctx, shown.first, shown.second)?.let { style ->
                        if (styleKey == shown) _state.update { it.copy(style = style) }
                    }
                }
            }
        }
    }

    fun show(svc: String) {
        if (_state.value.selected != svc) choose(svc)
    }

    fun choose(svc: String?) {
        val next = if (svc == _state.value.selected) null else svc
        _state.update {
            it.copy(
                selected = next,
                buses = emptyList(),
                busesStale = false,
                busStatus = if (next == null) null else BusStatus.Finding,
                sheet = (it.sheet as? MapSheet.Stop),
            )
        }
    }

    suspend fun refreshBuses() {
        val svc = _state.value.selected ?: return
        val token = store.token ?: return
        try {
            val list = api(token).buses(svc)
            if (svc != _state.value.selected) return
            val status =
                when {
                    !list.available -> BusStatus.Unavailable
                    list.buses.isEmpty() -> BusStatus.NoneRunning
                    else -> BusStatus.Running(list.buses.size)
                }
            busesAt = SystemClock.elapsedRealtime()
            _state.update { s ->
                val sheet = s.sheet.let { sh -> if (sh is MapSheet.Bus && list.buses.none { it.id == sh.id }) null else sh }
                s.copy(
                    buses = list.buses,
                    busesStale = list.stale && list.buses.isNotEmpty(),
                    busAnswers = s.busAnswers + 1,
                    busStatus = status,
                    sheet = sheet,
                )
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (e is ApiError && e.status == 401) {
                Session.rejected(getApplication(), token)
                return
            }
            val old = SystemClock.elapsedRealtime() - busesAt > BUSES_OLD_MS
            if (svc == _state.value.selected)
                _state.update { it.copy(busStatus = BusStatus.Unavailable, busesStale = it.busesStale || (old && it.buses.isNotEmpty())) }
        }
    }

    fun openStop(code: String) = _state.update {
        it.copy(sheet = MapSheet.Stop(code), board = null, boardFailed = false, boardError = false)
    }

    fun showStop(code: String, from: MapSheet.Bus? = null) = _state.update {
        if (it.campus != null && it.campus.stop(code) == null) it
        else
            it.copy(sheet = MapSheet.Stop(code, from), board = null, boardFailed = false, boardError = false, focus = code, focusBus = null)
    }

    fun openBus(id: String) = _state.update { it.copy(sheet = MapSheet.Bus(id)) }

    fun closeSheet() = _state.update { it.copy(sheet = null, board = null, focus = null, focusBus = null) }

    fun back() = _state.update { s ->
        val from = (s.sheet as? MapSheet.Stop)?.from?.takeIf { b -> s.buses.any { it.id == b.id } }
        if (from != null) s.copy(sheet = from, board = null, focus = null, focusBus = from.id)
        else s.copy(sheet = null, board = null, focus = null, focusBus = null)
    }

    private val _home = MutableSharedFlow<Unit>(extraBufferCapacity = 1)
    val homeTaps: SharedFlow<Unit> = _home

    fun home() {
        _state.update {
            it.copy(
                selected = null,
                buses = emptyList(),
                busesStale = false,
                busStatus = null,
                sheet = null,
                board = null,
                focus = null,
                focusBus = null,
            )
        }
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
                404 ->
                    if (open())
                        _state.update {
                            it.copy(board = Board(code, "", null, false, emptyList(), null), boardFailed = false, boardError = false)
                        }
                else -> if (open()) _state.update { it.copy(boardError = true, boardFailed = false) }
            }
        } catch (e: ParseError) {
            if (open()) _state.update { it.copy(boardError = true, boardFailed = false) }
        } catch (e: Exception) {
            if (open()) _state.update { it.copy(boardFailed = true, boardError = false) }
        }
    }

    suspend fun locate() {
        val ctx = getApplication<Application>()
        if (!Locator.hasForeground(ctx)) return
        val at = Locator.current(ctx) ?: return
        _state.update { it.copy(me = at.latitude to at.longitude) }
    }
}
