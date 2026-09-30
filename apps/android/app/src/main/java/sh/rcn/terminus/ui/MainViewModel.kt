package sh.rcn.terminus.ui

import android.app.Application
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
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Place
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.hour12
import sh.rcn.terminus.isNewer
import sh.rcn.terminus.deviceName
import sh.rcn.terminus.widget.redrawWidgets
import sh.rcn.terminus.widget.Refresher

data class UiState(
    val paired: Boolean = false,
    val target: Target = Target.Plan,
    val showNearby: Boolean = false,
    /** Last answer per view, so switching views never blanks the screen. */
    val answers: Map<Target, NextAnswer> = emptyMap(),
    /** Each answer as the server sent it, for an "Is this wrong?" report. */
    val rawAnswers: Map<Target, String> = emptyMap(),
    val nearby: List<NearbyStop>? = null,
    val places: List<Place> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val fetchedAt: Long? = null,
    val pairing: Boolean = false,
    val pairError: String? = null,
    val destinations: List<Destination> = emptyList(),
    /** A code from a pairing link, waiting for the user to confirm whose account it is. */
    val pendingPair: PendingPair? = null,
    /** A newer released version, when there is one. */
    val update: String? = null,
    /** "Notify me when to leave for class". */
    val leaveAlerts: Boolean = false,
    /** The live notification during your day. */
    val liveUpdates: Boolean = false,
    /** An "Is this wrong?" report on its way, and how it went. */
    val reportSending: Boolean = false,
    val reportResult: String? = null,
) {
    val answer: NextAnswer? get() = answers[target]
}

data class PendingPair(val code: String, val account: String)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(
        UiState(paired = store.paired, places = store.lastAnswer()?.first?.places.orEmpty(), leaveAlerts = store.leaveAlerts && LeaveAlerts.canNotify(app), liveUpdates = store.liveUpdates && LeaveAlerts.canNotify(app)),
    )
    val state: StateFlow<UiState> = _state
    private var loadJob: Job? = null

    fun pair(code: String) {
        _state.update { it.copy(pairing = true, pairError = null, pendingPair = null) }
        viewModelScope.launch {
            try {
                store.token = Api(null).pair(code.trim(), deviceName())
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

    /**
     * A pairing link opens the app with a code someone generated. Show whose
     * account it is and wait for a yes: otherwise any link could quietly pair
     * this phone to a stranger's account.
     */
    fun checkPairLink(code: String) {
        if (_state.value.paired) return
        _state.update { it.copy(pairing = true, pairError = null) }
        viewModelScope.launch {
            try {
                val account = Api(null).pairCheck(code)
                _state.update { it.copy(pairing = false, pendingPair = PendingPair(code, account)) }
            } catch (e: ApiError) {
                _state.update { it.copy(pairing = false, pairError = e.message) }
            } catch (e: Exception) {
                _state.update { it.copy(pairing = false, pairError = "Couldn't reach terminus. Check your connection and try again.") }
            }
        }
    }

    /** Turned on only after notification permission was granted. */
    fun setLeaveAlerts(on: Boolean) {
        val ctx = getApplication<Application>()
        store.leaveAlerts = on
        _state.update { it.copy(leaveAlerts = on) }
        if (on) {
            Refresher.schedule(ctx)
            store.lastAnswer()?.let { (a, at) -> Refresher.scheduleNext(ctx, a, at) }
            load(restart = true)
        } else {
            LeaveAlerts.cancel(ctx)
            // Nothing else needs the chain without a widget.
            if (!Refresher.active(ctx)) Refresher.cancel(ctx)
        }
    }

    /** Turned on only after notification permission was granted. */
    fun setLiveUpdates(on: Boolean) {
        val ctx = getApplication<Application>()
        store.liveUpdates = on
        _state.update { it.copy(liveUpdates = on) }
        if (on) {
            Refresher.schedule(ctx)
            LiveService.start(ctx)
        } else {
            LiveService.stop(ctx)
            if (!Refresher.active(ctx)) Refresher.cancel(ctx)
        }
        // The widget's refresh button comes and goes with this setting.
        viewModelScope.launch { redrawWidgets(ctx) }
    }

    fun dismissPairLink() = _state.update { it.copy(pendingPair = null) }

    /** A token was just stored (a new account, or a sign-in): start showing answers. */
    fun signedIn() {
        _state.update { it.copy(paired = true, pairError = null, answers = emptyMap(), rawAnswers = emptyMap()) }
        Refresher.schedule(getApplication())
        load(restart = true)
    }

    /** The account was deleted on the server: only local state is left to clear. */
    fun signedOut() {
        val ctx = getApplication<Application>()
        store.clear()
        Refresher.cancel(ctx)
        _state.value = UiState(paired = false)
        viewModelScope.launch { redrawWidgets(ctx) }
    }

    /** Local state goes first, so the screen reacts at once even offline. */
    fun unpair() {
        val token = store.token
        val ctx = getApplication<Application>()
        store.clear()
        Refresher.cancel(ctx)
        _state.value = UiState(paired = false)
        viewModelScope.launch {
            redrawWidgets(ctx)
            runCatching { Api(token).logout() }
        }
    }

    /**
     * "Is this wrong?": sends `answer` (the raw answer that was on screen when
     * the dialog opened; the 30 s refresh may have replaced it since) and the note.
     */
    fun report(note: String, answer: String?, appVersion: String) {
        val token = store.token ?: return
        _state.update { it.copy(reportSending = true, reportResult = null) }
        viewModelScope.launch {
            val result = try {
                Api(token).report(note.trim(), answer?.let { org.json.JSONObject(it) }, appVersion)
                "Thanks, sent. It helps make the answers better."
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                e.message
            } catch (e: Exception) {
                "Couldn't send it. Check your connection and try again."
            }
            _state.update { it.copy(reportSending = false, reportResult = result) }
        }
    }

    fun clearReportResult() = _state.update { it.copy(reportResult = null) }

    /** At most once a day: is there a newer release than this one? */
    fun checkForUpdate(current: String) {
        val now = System.currentTimeMillis()
        store.latestVersion?.let { v -> if (isNewer(v, current)) _state.update { it.copy(update = v) } }
        if (now - store.lastUpdateCheck < 24 * 3_600_000L) return
        viewModelScope.launch {
            runCatching { Api(null).latestVersion() }.onSuccess { v ->
                store.lastUpdateCheck = now
                store.latestVersion = v
                _state.update { it.copy(update = v.takeIf { isNewer(it, current) }) }
            }
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
        val token = store.token
        if (token == null) {
            // The background refresh saw a 401 and cleared the token while
            // this screen was alive. Don't sit on a paired screen forever.
            if (_state.value.paired) _state.value = UiState(paired = false, pairError = REMOVED)
            return
        }
        if (loadJob?.isActive == true) {
            if (!restart) return
            loadJob?.cancel()
        }
        loadJob = viewModelScope.launch {
            _state.update { it.copy(loading = true, liveUpdates = store.liveUpdates) }
            val ctx = getApplication<Application>()
            // A fix from the last minute is as good as a new one, and costs no
            // wait: polling every 30 s must not mean a GPS request every 30 s.
            val loc = Locator.lastKnown(ctx, maxAgeMs = 60_000) ?: Locator.current(ctx)
            val api = Api(token, hour12 = hour12(ctx))
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
                        Refresher.scheduleNext(ctx, answer, now)
                        store.lastError = null
                        redrawWidgets(ctx)
                    }
                    _state.update {
                        it.copy(
                            answers = it.answers + (s.target to answer),
                            rawAnswers = it.rawAnswers + (s.target to json.toString()),
                            places = answer.places, loading = false, error = null, fetchedAt = now,
                        )
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                if (e.status == 401) {
                    store.clear()
                    Refresher.cancel(ctx)
                    redrawWidgets(ctx)
                    _state.value = UiState(paired = false, pairError = REMOVED)
                } else {
                    _state.update { it.copy(loading = false, error = e.message) }
                }
            } catch (e: ParseError) {
                // Not the network: the server said something this version can't read.
                _state.update { it.copy(loading = false, error = if (it.update != null) "Update terminus to keep going" else "Unexpected answer from terminus") }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = "Offline") }
            }
        }
    }

    private var destinationsJob: Job? = null

    fun loadDestinations() {
        if (_state.value.destinations.isNotEmpty() || destinationsJob?.isActive == true) return
        destinationsJob = viewModelScope.launch {
            runCatching { Api(store.token).destinations() }.onSuccess { d -> _state.update { it.copy(destinations = d) } }
        }
    }
}

private const val REMOVED = "This phone was signed out of your account. Sign in again with your email."
