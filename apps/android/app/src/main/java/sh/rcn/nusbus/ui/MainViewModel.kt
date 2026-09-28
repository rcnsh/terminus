package sh.rcn.nusbus.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.rcn.nusbus.Api
import sh.rcn.nusbus.ApiError
import sh.rcn.nusbus.Destination
import sh.rcn.nusbus.Locator
import sh.rcn.nusbus.NearbyStop
import sh.rcn.nusbus.NextAnswer
import sh.rcn.nusbus.Place
import sh.rcn.nusbus.Store
import sh.rcn.nusbus.Target
import sh.rcn.nusbus.widget.redrawWidgets
import sh.rcn.nusbus.widget.Refresher

data class UiState(
    val paired: Boolean = false,
    val target: Target = Target.Plan,
    val showNearby: Boolean = false,
    val answer: NextAnswer? = null,
    val nearby: List<NearbyStop>? = null,
    val places: List<Place> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val fetchedAt: Long? = null,
    val pairing: Boolean = false,
    val pairError: String? = null,
    val destinations: List<Destination> = emptyList(),
)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(UiState(paired = store.paired, places = store.lastAnswer()?.first?.places.orEmpty()))
    val state: StateFlow<UiState> = _state
    private var loadJob: Job? = null

    fun pair(code: String) {
        _state.update { it.copy(pairing = true, pairError = null) }
        viewModelScope.launch {
            try {
                val name = "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".take(40)
                store.token = Api(null).pair(code.trim(), name)
                _state.update { it.copy(paired = true, pairing = false) }
                Refresher.schedule(getApplication())
                load()
            } catch (e: ApiError) {
                _state.update { it.copy(pairing = false, pairError = e.message) }
            } catch (e: Exception) {
                _state.update { it.copy(pairing = false, pairError = "Couldn't reach nusbus. Check your connection and try again.") }
            }
        }
    }

    fun unpair() {
        val token = store.token
        viewModelScope.launch {
            runCatching { Api(token).logout() }
            store.clear()
            Refresher.cancel(getApplication())
            redrawWidgets(getApplication())
            _state.value = UiState(paired = false)
        }
    }

    fun select(target: Target) {
        _state.update { it.copy(target = target, showNearby = false, answer = null, error = null) }
        load()
    }

    fun showNearby() {
        _state.update { it.copy(showNearby = true, nearby = null, error = null) }
        load()
    }

    /** Fetch whatever is on screen. Safe to call repeatedly; only one runs. */
    fun load() {
        val token = store.token ?: return
        if (loadJob?.isActive == true) return
        loadJob = viewModelScope.launch {
            _state.update { it.copy(loading = true) }
            val ctx = getApplication<Application>()
            val loc = Locator.current(ctx)
            val api = Api(token)
            val s = _state.value
            try {
                if (s.showNearby) {
                    val stops = api.nearby(loc?.latitude, loc?.longitude)
                    _state.update { it.copy(nearby = stops, loading = false, error = null, fetchedAt = System.currentTimeMillis()) }
                } else {
                    val json = api.nextJson(s.target, loc?.latitude, loc?.longitude)
                    val answer = NextAnswer.parse(json)
                    val now = System.currentTimeMillis()
                    // The planned answer is exactly what the widget shows, so
                    // keep the widget in step while the app is open.
                    if (s.target == Target.Plan) {
                        store.saveAnswer(json, now)
                        store.lastError = null
                        redrawWidgets(ctx)
                    }
                    _state.update { it.copy(answer = answer, places = answer.places, loading = false, error = null, fetchedAt = now) }
                }
            } catch (e: ApiError) {
                if (e.status == 401) {
                    store.clear()
                    redrawWidgets(ctx)
                    _state.value = UiState(paired = false, pairError = "This phone was removed from your account. Pair it again.")
                } else {
                    _state.update { it.copy(loading = false, error = e.message) }
                }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = "Offline") }
            }
        }
    }

    fun loadDestinations() {
        if (_state.value.destinations.isNotEmpty()) return
        viewModelScope.launch {
            runCatching { Api(store.token).destinations() }.onSuccess { d -> _state.update { it.copy(destinations = d) } }
        }
    }
}
