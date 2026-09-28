package sh.rcn.terminus.ui

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.Destination
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Place
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.widget.redrawWidgets
import sh.rcn.terminus.widget.Refresher

data class UiState(
    val paired: Boolean = false,
    val target: Target = Target.Plan,
    val showNearby: Boolean = false,
    /** Last answer per view, so switching views never blanks the screen. */
    val answers: Map<Target, NextAnswer> = emptyMap(),
    val nearby: List<NearbyStop>? = null,
    val places: List<Place> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val fetchedAt: Long? = null,
    val pairing: Boolean = false,
    val pairError: String? = null,
    val destinations: List<Destination> = emptyList(),
) {
    val answer: NextAnswer? get() = answers[target]
}

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
                _state.update { it.copy(pairing = false, pairError = "Couldn't reach terminus. Check your connection and try again.") }
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
        _state.update { it.copy(target = target, showNearby = false, error = null) }
        load(restart = true)
    }

    fun showNearby() {
        _state.update { it.copy(showNearby = true, error = null) }
        load(restart = true)
    }

    /**
     * Fetch whatever is on screen. Safe to call repeatedly; only one runs.
     * `restart` drops a fetch in flight, so a newly chosen view loads now
     * rather than after the one it replaced.
     */
    fun load(restart: Boolean = false) {
        val token = store.token ?: return
        if (loadJob?.isActive == true) {
            if (!restart) return
            loadJob?.cancel()
        }
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
                        Refresher.scheduleDim(ctx, answer, now)
                        store.lastError = null
                        redrawWidgets(ctx)
                    }
                    _state.update { it.copy(answers = it.answers + (s.target to answer), places = answer.places, loading = false, error = null, fetchedAt = now) }
                }
            } catch (e: CancellationException) {
                throw e
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
