package sh.rcn.terminus.ui

import android.app.Application
import android.location.Location
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.CardAction
import sh.rcn.terminus.CrashReports
import sh.rcn.terminus.DayItem
import sh.rcn.terminus.DayPlan
import sh.rcn.terminus.Destination
import sh.rcn.terminus.Destinations
import sh.rcn.terminus.FirstFix
import sh.rcn.terminus.L
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.LiveService
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.Outdated
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.Place
import sh.rcn.terminus.Pull
import sh.rcn.terminus.PullOutcome
import sh.rcn.terminus.Push
import sh.rcn.terminus.R
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Session
import sh.rcn.terminus.Step
import sh.rcn.terminus.StepTarget
import sh.rcn.terminus.Store
import sh.rcn.terminus.Target
import sh.rcn.terminus.UpdateRequired
import sh.rcn.terminus.deviceName
import sh.rcn.terminus.hour12
import sh.rcn.terminus.isNewer
import sh.rcn.terminus.widget.Refresher
import sh.rcn.terminus.widget.isOld
import sh.rcn.terminus.widget.redrawWidgets

data class UiState(
    val paired: Boolean = false,
    val target: Target = Target.Plan,
    val answers: Map<Target, NextAnswer> = emptyMap(),
    val rawAnswers: Map<Target, String> = emptyMap(),
    val nearby: List<NearbyStop>? = null,
    val nearbyLoading: Boolean = false,
    val nearbyError: String? = null,
    val nearbyFetchedAt: Long? = null,
    val places: List<Place> = emptyList(),
    val added: List<Destinations.Dest> = emptyList(),
    val loading: Boolean = false,
    val error: String? = null,
    val fetchedAt: Long? = null,
    val pairing: Boolean = false,
    val pairError: String? = null,
    val destinations: List<Destination> = emptyList(),
    val pendingPair: PendingPair? = null,
    val update: String? = null,
    val leaveAlerts: Boolean = false,
    val liveUpdates: Boolean = false,
    val reportSending: Boolean = false,
    val reportResult: String? = null,
    val reportSent: Boolean = false,
    val day: DayPlan? = null,
    val removed: TodayNote? = null,
    val signalling: Boolean = false,
    val updateRequired: Boolean = false,
) {
    val answer: NextAnswer?
        get() = answers[target]

    val hasDay: Boolean
        get() = day != null && (day.items.isNotEmpty() || removed != null)

    fun withoutAccount() =
        copy(
            answers = emptyMap(),
            rawAnswers = emptyMap(),
            nearby = null,
            nearbyError = null,
            nearbyFetchedAt = null,
            places = emptyList(),
            day = null,
            removed = null,
            fetchedAt = null,
        )
}

data class TodayNote(val item: DayItem, val at: Int, val before: String?, val failed: Boolean = false)

data class PendingPair(val code: String, val account: String)

class MainViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)

    private val account = SupervisorJob(viewModelScope.coroutineContext[Job])
    private val _state: MutableStateFlow<UiState>

    init {
        val signedOut = Session.message(store.takeSignedOut())
        val paired = store.paired
        if (!paired && store.hasLeftovers()) Session.clearLocal(app)
        val last = if (paired) store.lastAnswer() else null
        _state =
            MutableStateFlow(
                UiState(
                        paired = paired,
                        places = last?.first?.places.orEmpty(),
                        added = store.addedPlaces,
                        leaveAlerts = store.leaveAlerts && LeaveAlerts.canNotify(app, LeaveAlerts.CHANNEL),
                        liveUpdates = store.liveUpdates && LeaveAlerts.canNotify(app, LiveService.CHANNEL),
                        day = store.lastDay()?.first,
                        pairError = signedOut,
                        updateRequired = Outdated.required,
                    )
                    .let { s -> seen(last)?.let { (a, at) -> s.copy(answers = mapOf(Target.Plan to a), fetchedAt = at) } ?: s }
            )
        viewModelScope.launch {
            Session.signedOut.collect {
                endAccount()
                _state.value = UiState(paired = false, pairError = Session.message(store.takeSignedOut()))
            }
        }
    }

    private fun seen(last: Pair<NextAnswer, Long>?): Pair<NextAnswer, Long>? {
        val (a, at) = last ?: return null
        return if (!isOld(a, ServerClock.now())) a to at else null
    }

    val state: StateFlow<UiState> = _state
    private var loadJob: Job? = null

    private var nearbyJob: Job? = null

    private var freshFix: Deferred<Location?>? = null
    private var lastFresh: Location? = null

    private var refixJob: Job? = null
    private var nearbyRefixJob: Job? = null

    private val answeredAt = mutableMapOf<Target, Long>()

    private var nearbyAnsweredAt: Long? = null

    fun pair(code: String) {
        if (_state.value.pairing) return
        _state.update { it.copy(pairing = true, pairError = null, pendingPair = null) }
        viewModelScope.launch {
            try {
                val token = Api(null).pair(code.trim(), deviceName())
                withContext(Dispatchers.IO) {
                    store.token = token
                    store.anonymous = false
                }
                Session.signedIn(getApplication())
                _state.update { it.copy(paired = true, pairing = false).withoutAccount() }
                Refresher.schedule(getApplication())
                Push.sync(getApplication())
                load()
            } catch (e: ApiError) {
                _state.update { it.copy(pairing = false, pairError = e.message) }
            } catch (e: Exception) {
                _state.update { it.copy(pairing = false, pairError = L.s(R.string.cant_reach)) }
            }
        }
    }

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
            if (!Refresher.active(ctx)) Refresher.cancel(ctx)
        }
        Push.sync(ctx)
    }

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
        Push.sync(ctx)
        redrawLater(ctx)
    }

    fun goLater(atMin: Int) {
        val token = store.token ?: return
        val target = _state.value.target
        if (target == Target.Plan) return
        viewModelScope.launch(account) {
            val ctx = getApplication<Application>()
            try {
                val (loc, _) = locate(ctx)
                val json = Api(token, hour12 = hour12(ctx)).once(target, atMin, loc?.latitude, loc?.longitude, Locator.accOf(loc))
                val now = System.currentTimeMillis()
                Refresher.scheduleNext(ctx, store.saveAnswer(json, now, sentWith = token) ?: return@launch, now)
                redrawWidgets(ctx)
                select(Target.Plan)
                loadDay()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                if (!rejected(e, token)) _state.update { it.copy(error = e.message) }
            } catch (e: Exception) {
                _state.update { it.copy(error = L.s(R.string.cant_add)) }
            }
        }
    }

    fun dismissPairLink() = _state.update { it.copy(pendingPair = null) }

    fun signedIn() {
        endAccount()
        _state.update { it.copy(paired = true, pairError = null).withoutAccount() }
        Refresher.schedule(getApplication())
        Push.sync(getApplication())
        load(restart = true)
    }

    fun recheckNotifications() {
        val ctx = getApplication<Application>()
        val leave = store.leaveAlerts && LeaveAlerts.canNotify(ctx, LeaveAlerts.CHANNEL)
        val live = store.liveUpdates && LeaveAlerts.canNotify(ctx, LiveService.CHANNEL)
        val was = _state.value
        if (was.leaveAlerts != leave || was.liveUpdates != live) {
            _state.update { it.copy(leaveAlerts = leave, liveUpdates = live) }
            if (Refresher.active(ctx)) {
                Refresher.schedule(ctx)
                store.lastAnswer()?.let { (a, at) -> Refresher.scheduleNext(ctx, a, at) }
            }
            if (live) LiveService.start(ctx) else LiveService.stop(ctx)
        }
        if (store.paired) Push.sync(ctx)
    }

    fun signedOut() {
        endAccount()
        Session.clearLocal(getApplication())
        _state.value = UiState(paired = false)
    }

    fun unpair() {
        endAccount()
        Session.signOut(getApplication())
        _state.value = UiState(paired = false)
    }

    private fun endAccount() {
        account.cancelChildren()
        _state.update { it.copy(loading = false, nearbyLoading = false, signalling = false, reportSending = false) }
    }

    private suspend fun rejected(e: ApiError, token: String): Boolean = e.status == 401 && Session.rejected(getApplication(), token)

    fun report(reason: String?, note: String, answer: String?, appVersion: String) {
        val token = store.token ?: return
        _state.update { it.copy(reportSending = true, reportResult = null) }
        viewModelScope.launch(account) {
            val failure =
                try {
                    Api(token).report(reason, note.trim(), answer?.let { org.json.JSONObject(it) }, appVersion)
                    null
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiError) {
                    e.message
                } catch (e: Exception) {
                    L.s(R.string.report_failed)
                }
            _state.update { it.copy(reportSending = false, reportResult = failure, reportSent = failure == null) }
        }
    }

    fun reportOpened() = _state.update { it.copy(reportResult = null, reportSent = false) }

    fun signal(action: CardAction) {
        val token = store.token ?: return
        if (action.id == "skipped")
            _state.value.day
                ?.items
                ?.firstOrNull { it.key == action.trip }
                ?.let {
                    removeFromToday(it)
                    return
                }
        send(token, Target.Plan) { api, _ -> api.signal(action.id, action.trip) }
    }

    fun step(step: Step, to: StepTarget?, dir: String?) {
        val token = store.token ?: return
        send(token, _state.value.target) { api, ctx ->
            val loc = Locator.lastKnown(ctx, maxAgeMs = 60_000)
            api.step(step, to, dir, loc?.latitude, loc?.longitude)
        }
    }

    private fun send(token: String, target: Target, call: suspend (Api, Application) -> org.json.JSONObject) {
        if (_state.value.signalling) return
        _state.update { it.copy(signalling = true, error = null) }
        viewModelScope.launch(account) {
            val ctx = getApplication<Application>()
            try {
                val json = call(Api(token, hour12 = hour12(ctx)), ctx)
                val now = System.currentTimeMillis()
                val plan = target == Target.Plan
                val answer =
                    (if (plan) store.saveAnswer(json, now, sentWith = token) else NextAnswer.parse(json))
                        ?: run {
                            _state.update { it.copy(signalling = false) }
                            return@launch
                        }
                if (plan) {
                    Refresher.scheduleNext(ctx, answer, now)
                    redrawWidgets(ctx)
                }
                answeredAt[target] = now
                _state.update {
                    it.copy(
                        signalling = false,
                        answers = it.answers + (target to answer),
                        rawAnswers = it.rawAnswers + (target to json.toString()),
                        fetchedAt = now,
                    )
                }
                if (plan) loadDay()
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                if (!rejected(e, token)) _state.update { it.copy(signalling = false, error = e.message) }
            } catch (e: ParseError) {
                _state.update { it.copy(signalling = false, error = L.s(R.string.unexpected_answer)) }
            } catch (e: Exception) {
                _state.update { it.copy(signalling = false, error = L.s(R.string.offline)) }
            }
        }
    }

    fun choose(s: sh.rcn.terminus.Suggestion, accept: Boolean) {
        val token = store.token ?: return
        if (_state.value.signalling) return
        _state.update { it.copy(signalling = true, error = null) }
        viewModelScope.launch(account) {
            try {
                Api(token).choice(if (accept) "accept" else "dismiss", id = s.id)
                _state.update { it.copy(signalling = false) }
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (e is ApiError && rejected(e, token)) return@launch
                _state.update { it.copy(signalling = false, error = e.message ?: L.s(R.string.cant_save)) }
            }
        }
    }

    fun removeFromToday(item: DayItem) {
        val token = store.token ?: return
        val items = _state.value.day?.items.orEmpty()
        val at = items.indexOfFirst { it.key == item.key }.takeIf { it >= 0 } ?: return
        _state.update { s ->
            s.copy(
                day = s.day?.let { d -> d.copy(items = d.items.filter { it.key != item.key }) },
                removed = TodayNote(item, at, items.getOrNull(at + 1)?.key),
            )
        }
        viewModelScope.launch(account) {
            val ctx = getApplication<Application>()
            try {
                applyPlan(ctx, Api(token, hour12 = hour12(ctx)).signal("skipped", item.key), token)
            } catch (e: CancellationException) {
                throw e
            } catch (_: ParseError) {} catch (e: Exception) {
                if (e is ApiError && rejected(e, token)) return@launch
                _state.update { s ->
                    val back =
                        s.day?.let { d ->
                            if (d.items.any { it.key == item.key }) d
                            else d.copy(items = d.items.toMutableList().apply { add(at.coerceAtMost(size), item) })
                        }
                    s.copy(day = back, removed = TodayNote(item, at, before = item.key, failed = true))
                }
            }
            dayJob?.cancel()
            loadDay()
        }
    }

    fun undoRemove() {
        val item = _state.value.removed?.takeIf { !it.failed }?.item ?: return
        val token = store.token ?: return
        _state.update { it.copy(removed = null) }
        viewModelScope.launch(account) {
            val ctx = getApplication<Application>()
            runCatching { applyPlan(ctx, Api(token, hour12 = hour12(ctx)).signal("reset", item.key), token) }
                .onFailure { e ->
                    if (e is CancellationException) throw e
                    if (e is ApiError && rejected(e, token)) return@launch
                    _state.update { it.copy(error = L.s(R.string.cant_put_back)) }
                }
            dayJob?.cancel()
            loadDay()
        }
    }

    fun dismissRemoved(key: String) = _state.update { if (it.removed?.item?.key == key) it.copy(removed = null) else it }

    private fun applyPlan(ctx: Application, json: org.json.JSONObject, token: String): Boolean {
        val now = System.currentTimeMillis()
        val answer = store.saveAnswer(json, now, sentWith = token) ?: return false
        Refresher.scheduleNext(ctx, answer, now)
        redrawLater(ctx)
        _state.update {
            it.copy(
                answers = it.answers + (Target.Plan to answer),
                rawAnswers = it.rawAnswers + (Target.Plan to json.toString()),
                fetchedAt = now,
            )
        }
        return true
    }

    private var dayJob: Job? = null
    private var dayJobLang: String? = null

    fun loadDay(restart: Boolean = false) {
        val token = store.token ?: return
        val lang = L.header()
        if (dayJob?.isActive == true) {
            if (!restart && dayJobLang == lang) return
            dayJob?.cancel()
        }
        dayJobLang = lang
        dayJob =
            viewModelScope.launch(account) {
                val loc = Locator.lastKnown(getApplication(), maxAgeMs = 60_000)
                try {
                    val (json, written) =
                        Api(token, hour12 = hour12(getApplication())).dayJson(loc?.latitude, loc?.longitude, Locator.accOf(loc))
                    val day = store.saveDay(json, System.currentTimeMillis(), sentWith = token, lang = written) ?: return@launch
                    _state.update { it.copy(day = day) }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {}
            }
    }

    fun checkForUpdate(current: String) {
        if (installedFromPlay(getApplication())) return
        val now = System.currentTimeMillis()
        store.latestVersion?.let { v -> if (isNewer(v, current)) _state.update { it.copy(update = v) } }
        if (now - store.lastUpdateCheck < 24 * 3_600_000L) return
        viewModelScope.launch {
            runCatching { Api(null).latestVersion() }
                .onSuccess { v ->
                    store.lastUpdateCheck = now
                    store.latestVersion = v
                    _state.update { it.copy(update = v.takeIf { isNewer(it, current) }) }
                }
        }
    }

    fun select(picked: Target) {
        val places = _state.value.places
        val target =
            (picked as? Target.Code)?.let { c ->
                places.find { it.label.equals(c.label, ignoreCase = true) }?.let { Target.SavedPlace(it.key) }
            } ?: picked
        when (target) {
            is Target.SavedPlace ->
                places
                    .find { it.key == target.key }
                    ?.let { store.noteDestination(Destinations.Dest(Destinations.placeId(it.key), it.label)) }
            is Target.Code ->
                setAdded(Destinations.add(store.addedPlaces, Destinations.Dest(Destinations.stopId(target.code), target.label), places))
            Target.Plan -> {}
        }
        _state.update { it.copy(target = target, error = null) }
        load(restart = true)
    }

    fun removeAdded(dest: Destinations.Dest) {
        setAdded(store.addedPlaces.filter { it.id != dest.id })
        val showing = (_state.value.target as? Target.Code)?.let { Destinations.stopId(it.code) == dest.id } == true
        if (showing) select(Target.Plan)
    }

    private fun setAdded(added: List<Destinations.Dest>) {
        if (added == store.addedPlaces) return
        store.addedPlaces = added
        _state.update { it.copy(added = added) }
        redrawLater(getApplication())
    }

    private fun redrawLater(ctx: Application) {
        viewModelScope.launch {
            try {
                redrawWidgets(ctx)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                CrashReports.caught(ctx, e)
            }
        }
    }

    private suspend fun locate(ctx: Application): Pair<Location?, Deferred<Location?>?> {
        val now = System.currentTimeMillis()
        val recent = lastFresh?.takeIf { now - it.time < FirstFix.RECENT_MS } ?: Locator.lastKnown(ctx, maxAgeMs = FirstFix.RECENT_MS)
        if (recent != null) return recent to null
        val fresh =
            freshFix?.takeIf { it.isActive } ?: viewModelScope.async { Locator.fresh(ctx)?.also { lastFresh = it } }.also { freshFix = it }
        val got = withTimeoutOrNull(FirstFix.FIX_GRACE_MS) { fresh.await() }
        val loc = FirstFix.toSend(got, Locator.lastKnown(ctx, maxAgeMs = FirstFix.FALLBACK_MS))
        return loc to (if (got == null) fresh else null)
    }

    private fun refixLater(fresh: Deferred<Location?>, sent: Location?, again: () -> Unit): Job {
        val sentAccM = Locator.accOf(sent)
        return viewModelScope.launch(account) {
            val got = fresh.await()
            if (FirstFix.reload(sent?.latitude, sent?.longitude, got?.latitude, got?.longitude, sentAccM, Locator.accOf(got))) again()
        }
    }

    fun load(restart: Boolean = false, refix: Boolean = true) {
        val token = store.token
        if (token == null) {
            if (_state.value.paired) _state.value = UiState(paired = false, pairError = Session.message(store.takeSignedOut()))
            return
        }
        if (loadJob?.isActive == true) {
            if (!restart) return
            loadJob?.cancel()
        }
        refixJob?.cancel()
        nearbyRefixJob?.cancel()
        loadJob =
            viewModelScope.launch(account) {
                _state.update { it.copy(loading = true, liveUpdates = store.liveUpdates) }
                val ctx = getApplication<Application>()
                val (loc, fresh) = locate(ctx)
                if (fresh != null && refix) refixJob = refixLater(fresh, loc) { load(restart = true, refix = false) }
                val api = Api(token, hour12 = hour12(ctx))
                val s = _state.value
                try {
                    val json = api.nextJson(s.target, loc?.latitude, loc?.longitude, Locator.accOf(loc))
                    val now = System.currentTimeMillis()
                    val answer =
                        (if (s.target == Target.Plan) store.saveAnswer(json, now, sentWith = token) else NextAnswer.parse(json))
                            ?: return@launch _state.update { it.copy(loading = false) }
                    if (s.target == Target.Plan) {
                        val before = _state.value.answers[Target.Plan]
                        val dayAge = now - store.dayFetchedAt
                        if (
                            _state.value.day == null ||
                                dayAge > DAY_MAX_AGE_MS ||
                                store.dayLang != L.header() ||
                                before?.destLabel != answer.destLabel ||
                                before?.card?.phase != answer.card?.phase
                        )
                            loadDay()
                        Refresher.scheduleNext(ctx, answer, now)
                        store.lastError = null
                        redrawWidgets(ctx)
                    }
                    answeredAt[s.target] = now
                    _state.update {
                        it.copy(
                            answers = it.answers + (s.target to answer),
                            rawAnswers = it.rawAnswers + (s.target to json.toString()),
                            places = answer.places,
                            loading = false,
                            error = null,
                            fetchedAt = now,
                            updateRequired = false,
                        )
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: UpdateRequired) {
                    _state.update { it.copy(loading = false, error = null, updateRequired = true) }
                } catch (e: ApiError) {
                    if (rejected(e, token) || e.status == 401) _state.update { it.copy(loading = false) }
                    else _state.update { it.copy(loading = false, error = e.message) }
                } catch (e: ParseError) {
                    _state.update {
                        it.copy(
                            loading = false,
                            error = if (it.update != null) L.s(R.string.update_to_continue) else L.s(R.string.unexpected_answer),
                        )
                    }
                } catch (e: Exception) {
                    _state.update { it.copy(loading = false, error = L.s(R.string.offline)) }
                }
            }
    }

    fun loadNearby(restart: Boolean = false, refix: Boolean = true) {
        val token = store.token ?: return load()
        if (nearbyJob?.isActive == true) {
            if (!restart) return
            nearbyJob?.cancel()
        }
        nearbyRefixJob?.cancel()
        refixJob?.cancel()
        nearbyJob =
            viewModelScope.launch(account) {
                _state.update { it.copy(nearbyLoading = true) }
                val ctx = getApplication<Application>()
                val (loc, fresh) = locate(ctx)
                if (fresh != null && refix) nearbyRefixJob = refixLater(fresh, loc) { loadNearby(restart = true, refix = false) }
                val failed = { why: String? -> _state.update { it.copy(nearbyLoading = false, nearbyError = why) } }
                try {
                    val stops = Api(token, hour12 = hour12(ctx)).nearby(loc?.latitude, loc?.longitude, Locator.accOf(loc))
                    val now = System.currentTimeMillis()
                    nearbyAnsweredAt = now
                    _state.update {
                        it.copy(nearby = stops, nearbyLoading = false, nearbyError = null, nearbyFetchedAt = now, updateRequired = false)
                    }
                } catch (e: CancellationException) {
                    throw e
                } catch (e: UpdateRequired) {
                    _state.update { it.copy(nearbyLoading = false, nearbyError = L.s(R.string.update_to_continue), updateRequired = true) }
                } catch (e: ApiError) {
                    failed(if (rejected(e, token) || e.status == 401) null else e.message)
                } catch (e: ParseError) {
                    failed(if (_state.value.update != null) L.s(R.string.update_to_continue) else L.s(R.string.unexpected_answer))
                } catch (e: Exception) {
                    failed(L.s(R.string.offline))
                }
            }
    }

    suspend fun pull(): PullOutcome {
        val start = System.currentTimeMillis()
        if (loadJob?.isActive != true && !Pull.shouldFetch(answeredAt[_state.value.target], start)) return PullOutcome.UpToDate
        load()
        while (true) {
            val job = loadJob ?: break
            job.join()
            if (loadJob === job) break
        }
        return Pull.outcome(fetched = true, ok = (answeredAt[_state.value.target] ?: 0) >= start)
    }

    suspend fun pullNearby(): PullOutcome {
        val start = System.currentTimeMillis()
        if (nearbyJob?.isActive != true && !Pull.shouldFetch(nearbyAnsweredAt, start)) return PullOutcome.UpToDate
        loadNearby()
        while (true) {
            val job = nearbyJob ?: break
            job.join()
            if (nearbyJob === job) break
        }
        return Pull.outcome(fetched = true, ok = (nearbyAnsweredAt ?: 0) >= start)
    }

    private var destinationsJob: Job? = null

    fun loadDestinations() {
        if (_state.value.destinations.isNotEmpty() || destinationsJob?.isActive == true) return
        destinationsJob =
            viewModelScope.launch(account) {
                runCatching { Api(store.token).destinations() }.onSuccess { d -> _state.update { it.copy(destinations = d) } }
            }
    }
}

internal fun installedFromPlay(ctx: android.content.Context): Boolean = runCatching {
    ctx.packageManager.getInstallSourceInfo(ctx.packageName).installingPackageName == "com.android.vending"
}
    .getOrDefault(false)

internal const val POLL_MS = 30_000L

private const val DAY_MAX_AGE_MS = 120_000L
