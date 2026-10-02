package sh.rcn.terminus.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.CampusMap
import sh.rcn.terminus.LiveBus
import sh.rcn.terminus.Locator
import sh.rcn.terminus.MapFiles
import sh.rcn.terminus.StopBoard
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
    data class Stop(val code: String) : MapSheet
    data class Bus(val id: String) : MapSheet
}

data class MapUi(
    val campus: CampusMap? = null,
    /** Codes of the main campus's stops, for the first view. */
    val core: Set<String> = emptySet(),
    /** The style JSON for the current theme and language. */
    val style: String? = null,
    /** Nothing to show: no connection the first time. */
    val failed: Boolean = false,
    /** The service whose pill is on. */
    val selected: String? = null,
    val buses: List<LiveBus> = emptyList(),
    val busStatus: BusStatus? = null,
    val sheet: MapSheet? = null,
    /** The open stop's board; null while it loads. */
    val board: StopBoard? = null,
    /** True when the board couldn't be fetched at all (offline). */
    val boardFailed: Boolean = false,
    /** Where the phone is, only with location already allowed. */
    val me: Pair<Double, Double>? = null,
)

/**
 * The Map tab. The screen drives the polling (only while it's on screen):
 * [refreshBuses] every 10 s while a pill is on, [refreshBoard] every 15 s
 * while a stop's sheet is open, [locate] now and then.
 */
class MapViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(MapUi())
    val state: StateFlow<MapUi> = _state

    private var styleKey: Pair<Boolean, Boolean>? = null

    private fun api() = Api(store.token)

    /** The stops, routes and style; again when the theme or language changes. */
    fun open(dark: Boolean, zh: Boolean) {
        val ctx = getApplication<Application>()
        if (styleKey != dark to zh) {
            styleKey = dark to zh
            viewModelScope.launch {
                val style = MapFiles.style(ctx, dark, zh)
                _state.update { it.copy(style = style ?: it.style, failed = style == null && it.style == null) }
            }
        }
        if (_state.value.campus == null) {
            viewModelScope.launch {
                try {
                    val json = MapFiles.campus(ctx, api())
                    if (json == null) {
                        _state.update { it.copy(failed = true) }
                    } else {
                        val (campus, core) = CampusMap.parse(json)
                        _state.update { it.copy(campus = campus, core = core, failed = false) }
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    _state.update { it.copy(failed = true) }
                }
            }
            // The whole map file for offline, in the background. The first
            // time, the map is plain until it's here; then the streets appear.
            viewModelScope.launch {
                val had = MapFiles.hasTiles(ctx)
                MapFiles.keepTiles(ctx)
                val key = styleKey
                if (!had && MapFiles.hasTiles(ctx) && key != null) {
                    MapFiles.style(ctx, key.first, key.second)?.let { style -> _state.update { it.copy(style = style) } }
                }
            }
        }
    }

    /** One pill at a time; the same one again turns it off. */
    fun choose(svc: String?) {
        val next = if (svc == _state.value.selected) null else svc
        _state.update { it.copy(selected = next, buses = emptyList(), busStatus = if (next == null) null else BusStatus.Finding, sheet = (it.sheet as? MapSheet.Stop)) }
    }

    suspend fun refreshBuses() {
        val svc = _state.value.selected ?: return
        try {
            val list = api().buses(svc)
            if (svc != _state.value.selected) return
            val status = when {
                !list.available -> BusStatus.Unavailable
                list.buses.isEmpty() -> BusStatus.NoneRunning
                else -> BusStatus.Running(list.buses.size)
            }
            _state.update { s ->
                // A bus whose card is open and has gone: close the card.
                val sheet = s.sheet.let { sh -> if (sh is MapSheet.Bus && list.buses.none { it.id == sh.id }) null else sh }
                s.copy(buses = list.buses, busStatus = status, sheet = sheet)
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (svc == _state.value.selected) _state.update { it.copy(busStatus = BusStatus.Unavailable) }
        }
    }

    fun openStop(code: String) = _state.update { it.copy(sheet = MapSheet.Stop(code), board = null, boardFailed = false) }

    fun openBus(id: String) = _state.update { it.copy(sheet = MapSheet.Bus(id)) }

    fun closeSheet() = _state.update { it.copy(sheet = null, board = null) }

    suspend fun refreshBoard() {
        val code = (_state.value.sheet as? MapSheet.Stop)?.code ?: return
        try {
            val board = api().arrivals(code)
            if ((_state.value.sheet as? MapSheet.Stop)?.code == code) _state.update { it.copy(board = board, boardFailed = false) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            if ((_state.value.sheet as? MapSheet.Stop)?.code == code) _state.update { it.copy(board = StopBoard(false, emptyList())) }
        } catch (e: Exception) {
            if ((_state.value.sheet as? MapSheet.Stop)?.code == code) _state.update { it.copy(boardFailed = true) }
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
