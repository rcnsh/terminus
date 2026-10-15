package sh.rcn.terminus.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
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

/** Where an email sign-in is. */
sealed interface SignIn {
    /** Typing the address. */
    data object Email : SignIn

    /** The email is sent: show [match] and wait for the approval. */
    data class Waiting(val email: String, val match: Int) : SignIn

    /** Approved, and both this phone and the account have a setup: which one stays? */
    data class Choose(val email: String) : SignIn
}

data class AccountState(
    /** The account's email; null for an account without one. */
    val email: String? = null,
    val profile: ProfileDoc? = null,
    val campus: Campus? = null,
    val devices: List<Device>? = null,
    /** A pairing code for another device, while it's shown. */
    val pairCode: String? = null,
    val signIn: SignIn? = null,
    val busy: Boolean = false,
    /** A problem, or a result, to show once. */
    val message: String? = null,
    val importing: Boolean = false,
    val imported: ImportResult? = null,
    /** A NUSMods link shared into the app, waiting to be imported. */
    val sharedLink: String? = null,
    /** Classes with a bus earlier or no reminders. */
    val choices: List<sh.rcn.terminus.TripChoice> = emptyList(),
    /** Trips remembered (the last 35 days), which "Clear trip history" forgets. */
    val history: Int = 0,
    /** The language just changed: on Android 12 the activity is recreated to show it. */
    val langChanged: Boolean = false,
    /**
     * Counts saves that changed the account's language. The server writes the card and the day in the account's language, not the one asked
     * in, so what was fetched between the switch and this save is in the old one.
     */
    val langSaved: Int = 0,
    /** The timetable is for a semester that has ended (/me needsReimport), and which one. */
    val needsReimport: Boolean = false,
    val term: String? = null,
    /** Imported classes whose room couldn't be placed, until each gets a stop or is skipped. */
    val unplaced: List<sh.rcn.terminus.Unplaced> = emptyList(),
    /** /me, unanswered at sign-in, has since said the account was never set up: the app switches to setup ([setupShown] once it has). */
    val setupDue: Boolean = false,
)

/** Everything about the account rather than the answer: starting without one, signing in, the in-app setup, settings and devices. */
class AccountViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(AccountState(email = store.email))
    val state: StateFlow<AccountState> = _state

    init {
        // Signed out by a refused token (here or anywhere else): nothing of the account stays on screen.
        viewModelScope.launch { Session.signedOut.collect { reset() } }
    }

    private fun api() = Api(store.token)

    private fun fail(e: Throwable): String =
        when (e) {
            is ApiError -> e.message ?: L.s(R.string.something_wrong)
            // The server answered, with something this version can't read.
            is ParseError -> L.s(R.string.unexpected_answer)
            else -> L.s(R.string.cant_reach)
        }

    /**
     * What to say about [e], or null for nothing: a 401 for [sent], this phone's token, signs the phone out ([Session.rejected]) and the
     * welcome screen says why. Cancellation goes on up.
     */
    private suspend fun failure(e: Throwable, sent: String?): String? {
        if (e is CancellationException) throw e
        if (e is ApiError && e.status == 401 && Session.rejected(getApplication(), sent)) return null
        return fail(e)
    }

    /**
     * Runs [block]; a failure is said in the message (the server's words for a refusal, else that it can't be reached), with [failed]
     * putting back what was under way (busy, importing). With [session], a 401 is this phone's token refused, which signs it out; off for
     * the requests that carry another token, or none.
     */
    private fun attempt(failed: (AccountState) -> AccountState = { it }, session: Boolean = true, block: suspend () -> Unit) {
        val sent = store.token.takeIf { session }
        viewModelScope.launch {
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

    /** "Get started": an account with no email, made for this phone. */
    fun start(onDone: () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, message = null) }
        attempt({ it.copy(busy = false) }, session = false) {
            val token = Api(null).anon(deviceName())
            // Off the main thread: a Keystore round trip and a write to disk.
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

    /** Who this phone is signed in as, and the profile, for settings and setup. */
    fun refresh() {
        val token = store.token ?: return
        _state.update { it.copy(message = null) }
        viewModelScope.launch {
            try {
                val me = Api(token).me()
                store.email = me.email
                store.anonymous = me.anonymous
                settle(me)
                _state.update { it.copy(email = me.email, needsReimport = me.needsReimport, term = me.term) }
            } catch (e: Exception) {
                // Said below, with the profile, unless it signed the phone out.
                if (failure(e, token) == null) return@launch
            }
            try {
                val tagged = Api(token).profile()
                val p = ProfileDoc(tagged.json)
                // A change still being saved stays on screen.
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

    /** Unknown since sign-in: settled now, and setup shown only if /me says so. */
    private fun settle(me: Me) {
        if (!store.setupUnknown) return
        store.setupUnknown = false
        if (me.needsSetup) {
            store.needsSetup = true
            _state.update { it.copy(setupDue = true) }
        }
    }

    private var settleJob: Job? = null

    /**
     * Whether the account needs setup, while sign-in left it unknown: /me alone, one ask at a time, rather than the whole of [refresh] (the
     * profile and the campus too) each time an answer comes through.
     */
    fun settleSetup() {
        val token = store.token ?: return
        if (!store.setupUnknown || settleJob?.isActive == true) return
        settleJob = viewModelScope.launch {
            try {
                settle(Api(token).me())
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Still unknown: the next answer that comes through asks again.
            }
        }
    }

    fun loadCampus() {
        if (_state.value.campus != null) return
        viewModelScope.launch {
            try {
                val c = Api(store.token).campus()
                _state.update { it.copy(campus = c) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: ParseError) {
                // Offline, the pickers wait for the next try; a reply this version can't read is said.
                _state.update { it.copy(message = fail(e)) }
            } catch (e: Exception) {
                // Tried again when a picker opens.
            }
        }
    }

    /** The 0.4 s wait before a save, so a run of taps goes as one. */
    private var saveJob: Job? = null
    /**
     * The save on its way. Another edit doesn't cancel it: whether it saved is only known from its answer, and a change sent must not be
     * made twice. In [saves], so leaving the app straight after a tap doesn't cancel it either.
     */
    private var sending: Job? = null
    private val saves = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    /** The profile as the server last had it, to go back to if a save fails, and its version (the ETag) for If-Match. */
    private var confirmed: ProfileDoc? = null
    private var version: String? = null
    /** The changes made since the last save was sent, shown already, to send next. */
    private val pending = mutableListOf<ProfileChange>()
    /** Whether a change is waiting or on its way: the profile shown is ahead of the server's. */
    private val saving: Boolean
        get() = saveJob != null || sending != null || pending.isNotEmpty()

    /**
     * Changes the profile and saves it. Shown straight away and saved a moment later, so a run of taps is one save, as on the web; if the
     * server refuses, the saved one comes back with the reason. Only [change] is sent, made again on the profile as the server has it, so a
     * save never puts back what another device changed since this one loaded it.
     */
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

    /**
     * Sends the changes waiting, made on the profile as the server last had it. One save at a time: changes made meanwhile wait for its
     * answer and go next, on what it saved. None while an import runs: they go on top of its answer.
     */
    private fun send() {
        if (sending != null || _state.value.importing || pending.isEmpty()) return
        val token = store.token ?: return
        val base = confirmed ?: return
        // Left (onCleared), and signed into another account before the last save came back: these were the last account's.
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
                // The card and the day come in the account's language: what came since the switch is in the old one.
                if (r.doc.lang != confirmed?.lang) _state.update { it.copy(langSaved = it.langSaved + 1) }
                confirmed = r.doc
                // Changes made since this was sent stay on screen, on top of what it saved.
                val shown = r.doc.copy().also { d -> pending.forEach { it(d) } }
                _state.update { it.copy(profile = shown, message = if (r.missed) L.s(R.string.class_changed_elsewhere) else it.message) }
                if (saveJob == null) send()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                sending = null
                val message = failure(e, token) ?: return@launch
                // What failed goes back; changes made since stay on screen, and go in a save of their own.
                val shown = (confirmed ?: base).copy().also { d -> pending.forEach { it(d) } }
                _state.update { it.copy(profile = shown, message = L.s(R.string.not_saved, message)) }
                if (saveJob == null) send()
            }
        }
    }

    /** The account's token when the app was left: [saves] outlives the view model, but not into another account. */
    private var leftWith: String? = null

    /** Leaving Settings straight after a tap: the change is still saved, one still waiting after the one on its way. */
    override fun onCleared() {
        leftWith = store.token
        saveJob?.cancel()
        saveJob = null
        send()
    }

    /** An import on its way: in [saves] too, so leaving the app doesn't cancel it, and the edits waiting for its answer are still saved. */
    private var importJob: Job? = null

    fun import(share: String) {
        val link = share.trim()
        if (link.isEmpty() || _state.value.importing) return
        val token = store.token ?: return
        // A change still waiting goes first, so it isn't saved over the import.
        if (saveJob != null) {
            saveJob?.cancel()
            saveJob = null
            send()
        }
        _state.update { it.copy(importing = true, imported = null, message = null) }
        importJob = saves.launch {
            try {
                // The save on its way lands before the import, not over it. Changes made from here wait for the import's answer, then go
                // on top of it.
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

    /** An unplaced class given a stop: added by hand at that stop, as the account page does. */
    fun place(u: sh.rcn.terminus.Unplaced, to: String) {
        edit {
            it.addManual(sh.rcn.terminus.Trip(u.day, u.arriveByMin, u.endMin, to, "${u.module} @ ${u.venue.substringBefore('-')}", u.venue))
        }
        skip(u)
    }

    fun skip(u: sh.rcn.terminus.Unplaced) = _state.update { it.copy(unplaced = it.unplaced - u) }

    /** NUSMods' Share sheet, pointed at terminus. */
    fun shared(link: String) = _state.update { it.copy(sharedLink = link) }

    fun dismissShared() = _state.update { it.copy(sharedLink = null) }

    /**
     * The account's language and this phone's: a language picked here before the account had one (on the welcome screen) goes to the
     * account; one chosen on another device since is applied here.
     */
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

    /** Settings → Language: this phone, and the account so the Mac, the web and emails follow. */
    fun setLang(pref: String) {
        val app = getApplication<Application>()
        Lang.set(app, pref)
        Lang.noteAccount(app, pref)
        edit { it.lang = pref }
        _state.update { it.copy(langChanged = true) }
    }

    fun langShown() = _state.update { it.copy(langChanged = false) }

    /** Settings or setup: 12- or 24-hour times on every device; the widgets redraw in it. */
    fun setClock(pref: String) {
        val app = getApplication<Application>()
        Clock.keep(app, pref)
        edit { it.clock = pref }
        sh.rcn.terminus.widget.Refresher.refreshSoon(app)
    }

    /** Setup finished or skipped: never shown again, on any device. */
    fun finishSetup() {
        store.needsSetup = false
        val p = _state.value.profile
        if (p != null && "onboarding" !in p.seen) edit { it.markSeen("onboarding") }
    }

    private var pollJob: Job? = null
    private var request: SignInRequest? = null
    /** This phone's anonymous token while a sign-in may fold it into another account. */
    private var anonToken: String? = null
    private var approvedToken: String? = null

    fun beginSignIn() = _state.update { it.copy(signIn = SignIn.Email, message = null) }

    /** The code from the email, typed in: signs in straight away when it's right. */
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

    /** "Use a different email": back to the address, dropping the request sent. */
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

    /**
     * Emails an approval link. Sent with this phone's anonymous token (if it has one), so its setup is kept or offered when the account has
     * its own.
     */
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

    /** Every 3 seconds while the number is on screen, for up to the request's 15 minutes. */
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
                        continue // Offline for a moment: keep waiting.
                    }
                when (p.status) {
                    "pending" -> continue
                    // Approved always comes with both; one without is an answer this version can't use.
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
            // Both have a setup: keep the old token until the choice is made.
            // Not busy: a typed code leaves it set, and the choice's buttons
            // are off while it is.
            approvedToken = token
            _state.update { it.copy(signIn = SignIn.Choose(email), busy = false) }
            return
        }
        signedIn(token, email, onSignedIn)
    }

    /** After "choose": the account's setup, or this phone's. */
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
        // The page stays as it is, busy, until the app moves on.
        _state.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            // Off the main thread: a Keystore round trip and a write to disk.
            withContext(Dispatchers.IO) {
                store.token = token
                store.email = email
                store.anonymous = false
            }
            // A new account, or one that was never set up, goes through setup:
            // only on /me's word, asked once more after a moment. Unanswered,
            // no setup now (its pickers save the whole profile, which could
            // overwrite a real one); the next /me decides ([refresh]).
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
        viewModelScope.launch {
            try {
                val (c, history) = Api(sent).choices()
                _state.update { it.copy(choices = c, history = history) }
            } catch (e: Exception) {
                // Left as it was; a refused token still signs the phone out.
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

    /** Send feedback; [onSent] clears the box once it's gone. */
    fun sendFeedback(note: String, onSent: () -> Unit) {
        attempt({ it.copy(busy = false) }) {
            _state.update { it.copy(busy = true) }
            api().feedback(note.trim(), BuildConfig.VERSION_NAME)
            _state.update { it.copy(busy = false, message = L.s(R.string.feedback_thanks)) }
            onSent()
        }
    }

    /** Download my data, into the file the person picked. */
    fun exportTo(uri: android.net.Uri) {
        attempt {
            val json = api().export().toString(2)
            val written =
                withContext(Dispatchers.IO) {
                    getApplication<Application>().contentResolver.openOutputStream(uri)?.use { it.write(json.toByteArray()) }
                }
            // No file to write to (the provider gave none): nothing was saved.
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
                // This phone's session is gone with it: signed out here too.
                reset()
                onSelf()
            } else loadDevices()
        }
    }

    /** For an account with no email: everything goes, then the app starts over. */
    fun deleteAccount(onDone: () -> Unit) {
        attempt {
            api().deleteAccount()
            reset()
            onDone()
        }
    }

    /** The app has switched to setup after [AccountState.setupDue]. */
    fun setupShown() = _state.update { it.copy(setupDue = false) }

    /** After signing out: forget everything about the account. */
    fun reset() {
        pollJob?.cancel()
        // A Settings edit still waiting or on its way belonged to the account that's gone.
        saveJob?.cancel()
        saveJob = null
        sending?.cancel()
        sending = null
        pending.clear()
        confirmed = null
        version = null
        _state.value = AccountState()
    }
}
