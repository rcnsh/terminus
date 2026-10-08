package sh.rcn.terminus.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.CardAction
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.Destination
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.Destinations
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Place
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.hour12
import sh.rcn.terminus.isNewer
import sh.rcn.terminus.deviceName
import sh.rcn.terminus.widget.forgetWidgets
import sh.rcn.terminus.widget.redrawWidgets
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.isOld
import sh.rcn.terminus.R
import sh.rcn.terminus.L

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
    /** Places added from "Go somewhere else", a tab each until removed (Destinations). */
    val added: List<Destinations.Dest> = emptyList(),
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
    /** An "Is this wrong?" report on its way, why it failed, and where it was sent for. */
    val reportSending: Boolean = false,
    val reportResult: String? = null,
    val reportedFor: Target? = null,
    /** The card's `line` when the report went: once the card says something else, it's another answer. */
    val reportedLine: String? = null,
    /** Today's timeline (/me/day), for under the planned answer. */
    val day: DayPlan? = null,
    /** Just swiped off Today, offered back with Undo in a bar at the foot of the screen. */
    val removed: DayItem? = null,
    /** Why a swipe off Today didn't take, in the same bar rather than the footer. */
    val removeError: String? = null,
    /** "Swipe to remove" beside Today's heading, until a row has been swiped. */
    val swipeHint: Boolean = false,
    /** The first removable row nudges aside once, the first time Today is shown. */
    val swipePeek: Boolean = false,
    /** A card button's signal on its way. */
    val signalling: Boolean = false,
) {
    val answer: NextAnswer? get() = answers[target]

    /** "✓ Reported, thanks" in place of "Is this wrong?": only on the tab and answer it was sent for. */
    val reportShown: Boolean get() = reportedFor == target && answer?.card?.line == reportedLine
}

/** How long "✓ Reported, thanks" stays before "Is this wrong?" comes back. */
private const val REPORTED_SHOWN_MS = 6_000L

data class PendingPair(val code: String, val account: String)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(
        UiState(paired = store.paired, places = store.lastAnswer()?.first?.places.orEmpty(), added = store.addedPlaces, leaveAlerts = store.leaveAlerts && LeaveAlerts.canNotify(app), liveUpdates = store.liveUpdates && LeaveAlerts.canNotify(app), day = store.lastDay()?.first, swipeHint = !store.swipedToday, swipePeek = !store.swipedToday && store.swipePeeks < SWIPE_PEEKS)
            .let { s -> seen()?.let { (a, at) -> s.copy(answers = mapOf(Target.Plan to a), fetchedAt = at) } ?: s },
    )

    /**
     * The last plan this phone was shown, while it still holds (before its
     * staleAt): drawn at once on opening the app, then refreshed, rather than
     * an empty card until the first answer arrives.
     */
    private fun seen(): Pair<NextAnswer, Long>? {
        if (!store.paired) return null
        val (a, at) = store.lastAnswer() ?: return null
        return if (!isOld(a, ServerClock.now())) a to at else null
    }
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
                _state.update { it.copy(pairing = false, pairError = L.s(R.string.cant_reach)) }
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
                _state.update { it.copy(pairing = false, pairError = L.s(R.string.cant_reach)) }
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

    /**
     * "Go later today" (phase 8.3): a one-off trip to the place on screen,
     * planned like a class. The plan comes back, so show it.
     */
    fun goLater(atMin: Int) {
        val token = store.token ?: return
        val target = _state.value.target
        if (target == Target.Plan) return
        viewModelScope.launch {
            val ctx = getApplication<Application>()
            try {
                val json = Api(token, hour12 = hour12(ctx)).once(target, atMin)
                val now = System.currentTimeMillis()
                store.saveAnswer(json, now)
                Refresher.scheduleNext(ctx, NextAnswer.parse(json), now)
                redrawWidgets(ctx)
                select(Target.Plan)
                loadDay()
            } catch (e: ApiError) {
                _state.update { it.copy(error = e.message) }
            } catch (e: Exception) {
                _state.update { it.copy(error = L.s(R.string.cant_add)) }
            }
        }
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
        viewModelScope.launch { forgetWidgets(ctx) }
    }

    /** Local state goes first, so the screen reacts at once even offline. */
    fun unpair() {
        val token = store.token
        val ctx = getApplication<Application>()
        store.clear()
        Refresher.cancel(ctx)
        _state.value = UiState(paired = false)
        viewModelScope.launch {
            forgetWidgets(ctx)
            runCatching { Api(token).logout() }
        }
    }

    /**
     * "Is this wrong?": sends `answer` (the raw answer that was on screen when
     * the dialog opened; the 30 s refresh may have replaced it since) and the
     * note. Once sent, `target` is marked reported; a failure is said instead.
     */
    fun report(note: String, answer: String?, target: Target, appVersion: String) {
        val token = store.token ?: return
        _state.update { it.copy(reportSending = true, reportResult = null) }
        viewModelScope.launch {
            val failure = try {
                Api(token).report(note.trim(), answer?.let { org.json.JSONObject(it) }, appVersion)
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                e.message
            } catch (e: Exception) {
                L.s(R.string.report_failed)
            }
            if (failure != null) {
                _state.update { it.copy(reportSending = false, reportResult = failure) }
                return@launch
            }
            // The answer on screen now, not the one reported: the card may have moved on while
            // the dialog was open, and the tick should still show that it went.
            _state.update { it.copy(reportSending = false, reportedFor = target, reportedLine = it.answers[target]?.card?.line) }
            // The tick is a moment's acknowledgement; then the link is back for the next answer.
            reportClearJob?.cancel()
            reportClearJob = viewModelScope.launch {
                delay(REPORTED_SHOWN_MS)
                _state.update { it.copy(reportedFor = null, reportedLine = null) }
            }
        }
    }

    private var reportClearJob: Job? = null

    fun clearReportResult() = _state.update { it.copy(reportResult = null) }

    /**
     * A card button: "On the D2", "Missed it", "Not going". The server records
     * it for every device and answers with the new planned answer. "Not going"
     * is a swipe off Today by another name, so it goes the same way: off the
     * list at once, with the same Undo bar.
     */
    fun signal(action: CardAction) {
        val token = store.token ?: return
        if (action.id == "skipped") _state.value.day?.items?.firstOrNull { it.key == action.trip }?.let { removeFromToday(it, swiped = false); return }
        if (_state.value.signalling) return
        _state.update { it.copy(signalling = true, error = null) }
        viewModelScope.launch {
            val ctx = getApplication<Application>()
            try {
                val json = Api(token, hour12 = hour12(ctx)).signal(action.id, action.trip)
                val answer = NextAnswer.parse(json)
                val now = System.currentTimeMillis()
                store.saveAnswer(json, now)
                Refresher.scheduleNext(ctx, answer, now)
                redrawWidgets(ctx)
                _state.update {
                    it.copy(
                        signalling = false,
                        answers = it.answers + (Target.Plan to answer),
                        rawAnswers = it.rawAnswers + (Target.Plan to json.toString()),
                        fetchedAt = now,
                    )
                }
                loadDay()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                _state.update { it.copy(signalling = false, error = e.message) }
            } catch (e: Exception) {
                _state.update { it.copy(signalling = false, error = L.s(R.string.offline)) }
            }
        }
    }

    /** "Leave earlier" or "No thanks" on a suggestion; the card then comes back without it. */
    fun choose(s: sh.rcn.terminus.Suggestion, accept: Boolean) {
        val token = store.token ?: return
        if (_state.value.signalling) return
        _state.update { it.copy(signalling = true, error = null) }
        viewModelScope.launch {
            try {
                Api(token).choice(if (accept) "accept" else "dismiss", id = s.id)
                _state.update { it.copy(signalling = false) }
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(signalling = false, error = e.message ?: L.s(R.string.cant_save)) }
            }
        }
    }

    /**
     * Swiped off Today, or "Not going" on the card: taken off today, whatever
     * it is (a timetabled class, one you added, a one-off trip, the trip
     * home). Gone from the list at once, with Undo for a few seconds.
     */
    fun removeFromToday(item: DayItem, swiped: Boolean = true) {
        val token = store.token ?: return
        _state.update { s ->
            s.copy(day = s.day?.let { d -> d.copy(items = d.items.filter { it.key != item.key }) }, removed = item, removeError = null)
        }
        viewModelScope.launch {
            val ctx = getApplication<Application>()
            try {
                applyPlan(ctx, Api(token, hour12 = hour12(ctx)).signal("skipped", item.key))
                if (swiped) {
                    store.swipedToday = true
                    _state.update { it.copy(swipeHint = false, swipePeek = false) }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(removed = null, removeError = (e as? ApiError)?.message ?: L.s(R.string.cant_remove)) }
            }
            dayJob?.cancel()
            loadDay()
        }
    }

    /** Undo on the bar: back on today's list. */
    fun undoRemove() {
        val item = _state.value.removed ?: return
        val token = store.token ?: return
        _state.update { it.copy(removed = null) }
        viewModelScope.launch {
            val ctx = getApplication<Application>()
            runCatching { applyPlan(ctx, Api(token, hour12 = hour12(ctx)).signal("reset", item.key)) }
                .onFailure { e -> if (e is CancellationException) throw e; _state.update { it.copy(error = L.s(R.string.cant_put_back)) } }
            dayJob?.cancel()
            loadDay()
        }
    }

    /** The Undo bar has gone (timed out or swiped away): only for the entry it was for, not a newer one that replaced it. */
    fun dismissRemoved(key: String) = _state.update { if (it.removed?.key == key) it.copy(removed = null) else it }

    fun dismissRemoveError() = _state.update { it.copy(removeError = null) }

    /** The row has nudged aside once: one fewer to go. */
    fun swipePeeked() {
        store.swipePeeks += 1
        _state.update { it.copy(swipePeek = false) }
    }

    /** A new plan from /me/signal: shown, cached for the widget, and the alarms moved. */
    private fun applyPlan(ctx: Application, json: org.json.JSONObject) {
        val answer = NextAnswer.parse(json)
        val now = System.currentTimeMillis()
        store.saveAnswer(json, now)
        Refresher.scheduleNext(ctx, answer, now)
        viewModelScope.launch { redrawWidgets(ctx) }
        _state.update { it.copy(answers = it.answers + (Target.Plan to answer), rawAnswers = it.rawAnswers + (Target.Plan to json.toString()), fetchedAt = now) }
    }

    private var dayJob: Job? = null

    /** Today's timeline; kept as it was when offline. */
    fun loadDay() {
        val token = store.token ?: return
        if (dayJob?.isActive == true) return
        dayJob = viewModelScope.launch {
            // Where the phone was a moment ago (no new fix): the next class from there, as the card has it.
            val loc = Locator.lastKnown(getApplication(), maxAgeMs = 60_000)
            runCatching { Api(token, hour12 = hour12(getApplication())).dayJson(loc?.latitude, loc?.longitude, Locator.accOf(loc)) }.onSuccess { json ->
                // Kept for when the phone goes offline (OfflineDay).
                store.saveDay(json, System.currentTimeMillis())
                _state.update { it.copy(day = DayPlan.parse(json)) }
            }
        }
    }

    /**
     * At most once a day: is there a newer release than this one? Not for an
     * install from Google Play, which updates it itself (and gets a release
     * only after review, so the website's version would be announced early).
     */
    fun checkForUpdate(current: String) {
        if (installedFromPlay(getApplication())) return
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

    fun select(picked: Target) {
        val places = _state.value.places
        // Somewhere that's a favourite already is that favourite's tab.
        val target = (picked as? Target.Code)?.let { c -> places.find { it.label.equals(c.label, ignoreCase = true) }?.let { Target.SavedPlace(it.key) } } ?: picked
        when (target) {
            // The widget ranks favourites by how often you ask for them.
            is Target.SavedPlace -> places.find { it.key == target.key }?.let { store.noteDestination(Destinations.Dest(Destinations.placeId(it.key), it.label)) }
            // Anywhere else gets a tab of its own, and a widget button, until removed.
            is Target.Code -> setAdded(Destinations.add(store.addedPlaces, Destinations.Dest(Destinations.stopId(target.code), target.label), places))
            Target.Plan -> {}
        }
        _state.update { it.copy(target = target, showNearby = false, error = null) }
        load(restart = true)
    }

    /** The X on an added place's tab: gone from the tabs and the widget; showing it, back to Next. */
    fun removeAdded(dest: Destinations.Dest) {
        setAdded(store.addedPlaces.filter { it.id != dest.id })
        val showing = (_state.value.target as? Target.Code)?.let { Destinations.stopId(it.code) == dest.id } == true
        if (!showing) return
        if (_state.value.showNearby) _state.update { it.copy(target = Target.Plan) } else select(Target.Plan)
    }

    private fun setAdded(added: List<Destinations.Dest>) {
        if (added == store.addedPlaces) return
        store.addedPlaces = added
        _state.update { it.copy(added = added) }
        viewModelScope.launch { redrawWidgets(getApplication()) }
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
            if (_state.value.paired) _state.value = UiState(paired = false, pairError = L.s(R.string.signed_out_removed))
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
                    val stops = api.nearby(loc?.latitude, loc?.longitude, Locator.accOf(loc))
                    _state.update { it.copy(nearby = stops, loading = false, error = null, fetchedAt = System.currentTimeMillis()) }
                } else {
                    val json = api.nextJson(s.target, loc?.latitude, loc?.longitude, Locator.accOf(loc))
                    val answer = NextAnswer.parse(json)
                    val now = System.currentTimeMillis()
                    // The planned answer is exactly what the widget shows, so
                    // keep the widget in step while the app is open.
                    if (s.target == Target.Plan) {
                        // The timeline moves when the answer's trip does.
                        val before = _state.value.answers[Target.Plan]
                        // And when the kept one is over two minutes old, as on the Mac: the
                        // copy from disk counts as loaded, so Today's leave-by times could
                        // be hours old beside a fresh card.
                        val dayAge = now - (store.lastDay()?.second ?: 0L)
                        if (_state.value.day == null || dayAge > DAY_MAX_AGE_MS || before?.destLabel != answer.destLabel || before?.card?.phase != answer.card?.phase) loadDay()
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
                // A 401 for a token replaced meanwhile (signed in again) says nothing about the new one.
                if (e.status == 401 && store.token != token) {
                    _state.update { it.copy(loading = false) }
                } else if (e.status == 401) {
                    store.clear()
                    Refresher.cancel(ctx)
                    forgetWidgets(ctx)
                    _state.value = UiState(paired = false, pairError = L.s(R.string.signed_out_removed))
                } else {
                    _state.update { it.copy(loading = false, error = e.message) }
                }
            } catch (e: ParseError) {
                // Not the network: the server said something this version can't read.
                _state.update { it.copy(loading = false, error = if (it.update != null) L.s(R.string.update_to_continue) else L.s(R.string.unexpected_answer)) }
            } catch (e: Exception) {
                _state.update { it.copy(loading = false, error = L.s(R.string.offline)) }
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

/** Installed by the Play Store, rather than the APK from the website. */
internal fun installedFromPlay(ctx: android.content.Context): Boolean =
    runCatching { ctx.packageManager.getInstallSourceInfo(ctx.packageName).installingPackageName == "com.android.vending" }.getOrDefault(false)

/**
 * The answer on Now is fetched again this often while it's on screen: the
 * API caches 15 s, so sooner shows nothing new. Not sooner at the server's
 * own moments (the card's `nextChangeAt`, the plan's `refreshAt`) either: a
 * leave time that keeps sliding (a late bus) moves them a few seconds on
 * with every answer, which brought the polling down to every 5 s. The
 * countdown ticks on the phone in between; the Mac and the server's trip
 * engine wait 30 s too.
 */
internal const val POLL_MS = 30_000L

/** Today is fetched again with the answer once it's this old. */
private const val DAY_MAX_AGE_MS = 120_000L

/** How many times, at most, a Today row nudges aside to show it can be swiped: once is enough with the label beside the heading. */
private const val SWIPE_PEEKS = 1
