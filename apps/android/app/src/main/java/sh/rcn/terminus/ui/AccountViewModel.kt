package sh.rcn.terminus.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlin.coroutines.EmptyCoroutineContext
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.Campus
import sh.rcn.terminus.Clock
import sh.rcn.terminus.Device
import sh.rcn.terminus.ImportResult
import sh.rcn.terminus.L
import sh.rcn.terminus.Lang
import sh.rcn.terminus.MapFiles
import sh.rcn.terminus.Me
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.ProfileChange
import sh.rcn.terminus.ProfileDoc
import sh.rcn.terminus.R
import sh.rcn.terminus.Session
import sh.rcn.terminus.SignInRequest
import sh.rcn.terminus.Store
import sh.rcn.terminus.deviceName
import sh.rcn.terminus.saveChanges

sealed interface SignIn {
    data object Email : SignIn

    data class Waiting(val email: String, val match: Int) : SignIn

    data class Choose(val email: String) : SignIn
}

data class AccountState(
    val email: String? = null,
    val profile: ProfileDoc? = null,
    val campus: Campus? = null,
    val devices: List<Device>? = null,
    val pairCode: String? = null,
    val signIn: SignIn? = null,
    val busy: Boolean = false,
    val message: String? = null,
    val importing: Boolean = false,
    val imported: ImportResult? = null,
    val sharedLink: String? = null,
    val choices: List<sh.rcn.terminus.TripChoice> = emptyList(),
    val history: Int = 0,
    val langChanged: Boolean = false,
    val langSaved: Int = 0,
    val needsReimport: Boolean = false,
    val term: String? = null,
    val unplaced: List<sh.rcn.terminus.Unplaced> = emptyList(),
    val setupDue: Boolean = false,
)

class AccountViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(AccountState(email = store.email))
    val state: StateFlow<AccountState> = _state

    private val account = SupervisorJob(viewModelScope.coroutineContext[Job])

    init {
        viewModelScope.launch { Session.signedOut.collect { reset() } }
        viewModelScope.launch {
            MapFiles.onCampusChange({ _state.value.campus != null }, Campus::parse) { c -> _state.update { it.copy(campus = c) } }
        }
    }

    private fun api() = Api(store.token)

    private fun fail(e: Throwable): String =
        when (e) {
            is ApiError -> e.message ?: L.s(R.string.something_wrong)
            is ParseError -> L.s(R.string.unexpected_answer)
            else -> L.s(R.string.cant_reach)
        }

    private suspend fun failure(e: Throwable, sent: String?): String? {
        if (e is CancellationException) throw e
        if (e is ApiError && e.status == 401 && Session.rejected(getApplication(), sent)) return null
        return fail(e)
    }

    private fun attempt(failed: (AccountState) -> AccountState = { it }, session: Boolean = true, block: suspend () -> Unit) {
        val sent = store.token.takeIf { session }
        viewModelScope.launch(if (session) account else EmptyCoroutineContext) {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val message = failure(e, sent)
                _state.update { failed(it).copy(message = message ?: it.message) }
            }
        }
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    fun start(onDone: () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, message = null) }
        attempt({ it.copy(busy = false) }, session = false) {
            val token = Api(null).anon(deviceName())
            withContext(Dispatchers.IO) {
                store.token = token
                store.email = null
                store.anonymous = true
                store.needsSetup = true
            }
            _state.update { it.copy(busy = false, email = null) }
            onDone()
        }
    }

    fun refresh() {
        val token = store.token ?: return
        _state.update { it.copy(message = null) }
        viewModelScope.launch(account) {
            try {
                val me = Api(token).me()
                store.email = me.email
                store.anonymous = me.anonymous
                settle(me)
                _state.update { it.copy(email = me.email, needsReimport = me.needsReimport, term = me.term) }
            } catch (e: Exception) {
                if (failure(e, token) == null) return@launch
            }
            try {
                val tagged = Api(token).profile()
                val p = ProfileDoc(tagged.json)
                if (!saving) {
                    confirmed = p
                    version = tagged.version
                    _state.update { it.copy(profile = p) }
                    syncLang(p)
                    Clock.keep(getApplication(), p.clock)
                }
            } catch (e: Exception) {
                val message = failure(e, token) ?: return@launch
                if (_state.value.profile == null) _state.update { it.copy(message = message) }
            }
            loadCampus()
        }
    }

    private fun settle(me: Me) {
        if (!store.setupUnknown) return
        store.setupUnknown = false
        if (me.needsSetup) {
            store.needsSetup = true
            _state.update { it.copy(setupDue = true) }
        }
    }

    private var settleJob: Job? = null

    fun settleSetup() {
        val token = store.token ?: return
        if (!store.setupUnknown || settleJob?.isActive == true) return
        settleJob =
            viewModelScope.launch(account) {
                try {
                    settle(Api(token).me())
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {}
            }
    }

    fun loadCampus() {
        if (_state.value.campus != null) return
        viewModelScope.launch {
            try {
                val json = MapFiles.campus(getApplication(), Api(store.token)) ?: return@launch
                val c = withContext(Dispatchers.Default) { Campus.parse(json) }
                _state.update { it.copy(campus = c) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ParseError) {
                _state.update { it.copy(message = fail(e)) }
            } catch (e: Exception) {}
        }
    }

    private var saveJob: Job? = null
    private var sending: Job? = null
    private val saves = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var confirmed: ProfileDoc? = null
    private var version: String? = null
    private val pending = mutableListOf<ProfileChange>()
    private val saving: Boolean
        get() = saveJob != null || sending != null || pending.isNotEmpty()

    fun edit(change: ProfileChange) {
        val current = _state.value.profile ?: return
        if (!saving) confirmed = current
        val next = current.copy().also(change)
        pending += change
        _state.update { it.copy(profile = next) }
        saveJob?.cancel()
        saveJob = viewModelScope.launch {
            delay(400)
            saveJob = null
            send()
        }
    }

    private fun send() {
        if (sending != null || _state.value.importing || pending.isEmpty()) return
        val token = store.token ?: return
        val base = confirmed ?: return
        if (leftWith != null && token != leftWith) return pending.clear()
        val changes = pending.toList()
        pending.clear()
        val from = version
        sending = saves.launch {
            try {
                val api = Api(token)
                val r = saveChanges(base, from, changes, load = { api.profile() }, save = { json, tag -> api.saveProfile(json, tag) })
                sending = null
                version = r.version
                if (r.doc.lang != confirmed?.lang) _state.update { it.copy(langSaved = it.langSaved + 1) }
                confirmed = r.doc
                val shown = r.doc.copy().also { d -> pending.forEach { it(d) } }
                _state.update { it.copy(profile = shown, message = if (r.missed) L.s(R.string.class_changed_elsewhere) else it.message) }
                if (saveJob == null) send()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                sending = null
                val message = failure(e, token) ?: return@launch
                val shown = (confirmed ?: base).copy().also { d -> pending.forEach { it(d) } }
                _state.update { it.copy(profile = shown, message = L.s(R.string.not_saved, message)) }
                if (saveJob == null) send()
            }
        }
    }

    private var leftWith: String? = null

    override fun onCleared() {
        leftWith = store.token
        saveJob?.cancel()
        saveJob = null
        send()
    }

    private var importJob: Job? = null

    fun import(share: String) {
        val link = share.trim()
        if (link.isEmpty() || _state.value.importing) return
        val token = store.token ?: return
        if (saveJob != null) {
            saveJob?.cancel()
            saveJob = null
            send()
        }
        _state.update { it.copy(importing = true, imported = null, message = null) }
        importJob = saves.launch {
            try {
                while (true) (sending ?: break).join()
                val r = Api(token).import(link)
                val saved = ProfileDoc(r.result.profile)
                confirmed = saved
                version = r.version
                val shown = saved.copy().also { d -> pending.forEach { it(d) } }
                _state.update {
                    it.copy(
                        importing = false,
                        imported = r.result,
                        profile = shown,
                        sharedLink = null,
                        needsReimport = false,
                        term = r.result.term,
                        unplaced = r.result.unplaced,
                    )
                }
                if (saveJob == null) send()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(importing = false) }
                val message = failure(e, token) ?: return@launch
                if (saveJob == null) send()
                _state.update { it.copy(message = message) }
            }
        }
    }

    fun place(u: sh.rcn.terminus.Unplaced, to: String) {
        edit {
            it.addManual(
                sh.rcn.terminus.TimetableClass(u.day, u.arriveByMin, u.endMin, to, "${u.module} @ ${u.venue.substringBefore('-')}", u.venue)
            )
        }
        skip(u)
    }

    fun skip(u: sh.rcn.terminus.Unplaced) = _state.update { it.copy(unplaced = it.unplaced - u) }

    fun shared(link: String) = _state.update { it.copy(sharedLink = link) }

    fun dismissShared() = _state.update { it.copy(sharedLink = null) }

    private fun syncLang(p: ProfileDoc) {
        val app = getApplication<Application>()
        val local = Lang.pref(app)
        if (p.lang == Lang.AUTO && local != Lang.AUTO && Lang.applied(app) == null) {
            Lang.noteAccount(app, local)
            edit { it.lang = local }
        } else if (Lang.followAccount(app, p.lang)) {
            _state.update { it.copy(langChanged = true) }
        }
    }

    fun setLang(pref: String) {
        val app = getApplication<Application>()
        Lang.set(app, pref)
        Lang.noteAccount(app, pref)
        edit { it.lang = pref }
        _state.update { it.copy(langChanged = true) }
    }

    fun langShown() = _state.update { it.copy(langChanged = false) }

    fun setClock(pref: String) {
        val app = getApplication<Application>()
        Clock.keep(app, pref)
        edit { it.clock = pref }
        sh.rcn.terminus.widget.Refresher.refreshSoon(app)
    }

    fun finishSetup() {
        store.needsSetup = false
        val p = _state.value.profile
        if (p != null && "onboarding" !in p.seen) edit { it.markSeen("onboarding") }
    }

    private var pollJob: Job? = null
    private var request: SignInRequest? = null
    private var anonToken: String? = null
    private var approvedToken: String? = null

    fun beginSignIn() = _state.update { it.copy(signIn = SignIn.Email, message = null) }

    fun enterCode(code: String, onSignedIn: () -> Unit) {
        val r = request ?: return
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, message = null) }
        attempt({ it.copy(busy = false) }, session = false) {
            val p = Api(null).signInCode(r, code)
            if (p.status == "approved" && p.token != null && p.email != null) {
                pollJob?.cancel()
                approved(p.token, p.email, p.outcome, onSignedIn)
            } else _state.update { it.copy(busy = false) }
        }
    }

    fun differentEmail() {
        pollJob?.cancel()
        request = null
        _state.update { it.copy(signIn = SignIn.Email, busy = false, message = null) }
    }

    fun cancelSignIn() {
        pollJob?.cancel()
        request = null
        _state.update { it.copy(signIn = null, busy = false) }
    }

    fun sendSignIn(email: String, onSignedIn: () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, message = null) }
        attempt({ it.copy(busy = false) }) {
            anonToken = store.token
            val r = api().signInStart(email.trim(), deviceName())
            request = r
            _state.update { it.copy(busy = false, signIn = SignIn.Waiting(email.trim(), r.match)) }
            poll(onSignedIn)
        }
    }

    private fun poll(onSignedIn: () -> Unit) {
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            val r = request ?: return@launch
            val until = System.currentTimeMillis() + 15 * 60_000L
            while (System.currentTimeMillis() < until) {
                delay(3_000)
                val p =
                    try {
                        Api(null).signInPoll(r)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        continue
                    }
                when (p.status) {
                    "pending" -> continue
                    "approved" -> {
                        val token = p.token
                        val email = p.email
                        if (token != null && email != null) return@launch approved(token, email, p.outcome, onSignedIn)
                        break
                    }
                    "denied" -> return@launch _state.update { it.copy(signIn = SignIn.Email, message = L.s(R.string.signin_cancelled)) }
                    else -> break
                }
            }
            _state.update { it.copy(signIn = SignIn.Email, message = L.s(R.string.request_expired)) }
        }
    }

    private fun approved(token: String, email: String, outcome: String?, onSignedIn: () -> Unit) {
        request = null
        if (outcome == "choose") {
            approvedToken = token
            _state.update { it.copy(signIn = SignIn.Choose(email), busy = false) }
            return
        }
        signedIn(token, email, onSignedIn)
    }

    fun choose(keepPhone: Boolean, onSignedIn: () -> Unit) {
        val token = approvedToken ?: return
        val anon = anonToken
        val email = (state.value.signIn as? SignIn.Choose)?.email ?: return
        _state.update { it.copy(busy = true) }
        attempt({ it.copy(busy = false) }, session = false) {
            if (anon != null) Api(token).merge(anon, keepPhone)
            signedIn(token, email, onSignedIn)
        }
    }

    private fun signedIn(token: String, email: String, onSignedIn: () -> Unit) {
        approvedToken = null
        anonToken = null
        endAccount()
        _state.update { AccountState(campus = it.campus, signIn = it.signIn, busy = true) }
        viewModelScope.launch {
            withContext(Dispatchers.IO) {
                store.token = token
                store.email = email
                store.anonymous = false
            }
            Session.signedIn(getApplication())
            val me =
                runCatching { Api(token).me() }.getOrNull()
                    ?: run {
                        delay(1_000)
                        runCatching { Api(token).me() }.getOrNull()
                    }
            store.needsSetup = me?.needsSetup == true
            store.setupUnknown = me == null
            _state.update { it.copy(signIn = null, busy = false, email = email) }
            refresh()
            onSignedIn()
        }
    }

    fun loadChoices() {
        val sent = store.token
        viewModelScope.launch(account) {
            try {
                val (c, history) = Api(sent).choices()
                _state.update { it.copy(choices = c, history = history) }
            } catch (e: Exception) {
                failure(e, sent)
            }
        }
    }

    fun undoChoice(c: sh.rcn.terminus.TripChoice) {
        attempt {
            val list = api().choice("undo", trip = c.trip, pref = c.pref)
            _state.update { it.copy(choices = list) }
        }
    }

    fun clearHistory() {
        attempt {
            api().clearHistory()
            _state.update { it.copy(history = 0, message = L.s(R.string.history_cleared)) }
        }
    }

    fun sendFeedback(note: String, onSent: () -> Unit) {
        attempt({ it.copy(busy = false) }) {
            _state.update { it.copy(busy = true) }
            api().feedback(note.trim(), BuildConfig.VERSION_NAME)
            _state.update { it.copy(busy = false, message = L.s(R.string.feedback_thanks)) }
            onSent()
        }
    }

    fun exportTo(uri: android.net.Uri) {
        attempt {
            val json = api().export().toString(2)
            val written =
                withContext(Dispatchers.IO) {
                    getApplication<Application>().contentResolver.openOutputStream(uri)?.use { it.write(json.toByteArray()) }
                }
            _state.update { it.copy(message = L.s(if (written != null) R.string.export_saved else R.string.export_not_saved)) }
        }
    }

    fun loadDevices() {
        attempt {
            val d = api().devices()
            _state.update { it.copy(devices = d) }
        }
    }

    fun newPairCode() {
        attempt {
            val code = api().pairCode()
            _state.update { it.copy(pairCode = code) }
        }
    }

    fun closePairCode() {
        _state.update { it.copy(pairCode = null) }
        loadDevices()
    }

    fun removeDevice(d: Device, onSelf: () -> Unit) {
        attempt {
            api().removeDevice(d.id)
            if (d.current) {
                reset()
                onSelf()
            } else loadDevices()
        }
    }

    fun deleteAccount(onDone: () -> Unit) {
        attempt {
            api().deleteAccount()
            reset()
            onDone()
        }
    }

    fun setupShown() = _state.update { it.copy(setupDue = false) }

    fun reset() {
        pollJob?.cancel()
        endAccount()
        _state.value = AccountState()
    }

    private fun endAccount() {
        account.cancelChildren()
        importJob?.cancel()
        importJob = null
        saveJob?.cancel()
        saveJob = null
        sending?.cancel()
        sending = null
        pending.clear()
        confirmed = null
        version = null
    }
}
