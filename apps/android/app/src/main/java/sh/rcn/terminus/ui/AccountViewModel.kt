package sh.rcn.terminus.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import sh.rcn.terminus.Api
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.Campus
import sh.rcn.terminus.Clock
import sh.rcn.terminus.Device
import sh.rcn.terminus.ImportResult
import sh.rcn.terminus.ProfileDoc
import sh.rcn.terminus.SignInRequest
import sh.rcn.terminus.Store
import sh.rcn.terminus.deviceName
import sh.rcn.terminus.R
import sh.rcn.terminus.L
import sh.rcn.terminus.Lang

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
    /** Classes with a bus earlier or no reminders (phase 3). */
    val choices: List<sh.rcn.terminus.TripChoice> = emptyList(),
    /** Trips remembered (the last 35 days), which "Clear trip history" forgets. */
    val history: Int = 0,
    /** The language just changed: on Android 12 the activity is recreated to show it. */
    val langChanged: Boolean = false,
    /** The timetable is for a semester that has ended (/me needsReimport), and which one. */
    val needsReimport: Boolean = false,
    val term: String? = null,
    /** Imported classes whose room couldn't be placed, until each gets a stop or is skipped. */
    val unplaced: List<sh.rcn.terminus.Unplaced> = emptyList(),
)

/**
 * Everything about the account rather than the answer: starting without
 * one, signing in, the in-app setup, settings and devices.
 */
class AccountViewModel(app: Application) : AndroidViewModel(app) {
    private val store = Store(app)
    private val _state = MutableStateFlow(AccountState(email = store.email))
    val state: StateFlow<AccountState> = _state

    private fun api() = Api(store.token)

    private fun fail(e: Exception): String = when (e) {
        is ApiError -> e.message ?: L.s(R.string.something_wrong)
        else -> L.s(R.string.cant_reach)
    }

    fun clearMessage() = _state.update { it.copy(message = null) }

    /** "Get started": an account with no email, made for this phone. */
    fun start(onDone: () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                store.token = Api(null).anon(deviceName())
                store.email = null
                store.needsSetup = true
                _state.update { it.copy(busy = false, email = null) }
                onDone()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, message = fail(e)) }
            }
        }
    }

    /** Who this phone is signed in as, and the profile, for settings and setup. */
    fun refresh() {
        if (store.token == null) return
        _state.update { it.copy(message = null) }
        viewModelScope.launch {
            runCatching { api().me() }.onSuccess { me ->
                store.email = me.email
                _state.update { it.copy(email = me.email, needsReimport = me.needsReimport, term = me.term) }
            }
            runCatching { ProfileDoc(api().profile()) }
                .onSuccess { p ->
                    _state.update { it.copy(profile = p) }
                    syncLang(p)
                    Clock.keep(getApplication(), p.clock)
                }
                .onFailure { e -> if (_state.value.profile == null) _state.update { it.copy(message = fail(e as? Exception ?: Exception(e))) } }
            loadCampus()
        }
    }

    fun loadCampus() {
        if (_state.value.campus != null) return
        viewModelScope.launch {
            runCatching { Api(store.token).campus() }.onSuccess { c -> _state.update { it.copy(campus = c) } }
        }
    }

    /**
     * Changes the profile and saves it. Shown straight away; if the server
     * refuses, the saved one comes back with the reason.
     */
    fun edit(change: (ProfileDoc) -> Unit) {
        val current = _state.value.profile ?: return
        val next = current.copy().also(change)
        _state.update { it.copy(profile = next) }
        viewModelScope.launch {
            try {
                val saved = ProfileDoc(api().saveProfile(next.json))
                _state.update { it.copy(profile = saved) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(profile = current, message = L.s(R.string.not_saved, fail(e))) }
            }
        }
    }

    fun import(share: String) {
        val link = share.trim()
        if (link.isEmpty() || _state.value.importing) return
        _state.update { it.copy(importing = true, imported = null, message = null) }
        viewModelScope.launch {
            try {
                val r = api().import(link)
                _state.update { it.copy(importing = false, imported = r, profile = ProfileDoc(r.profile), sharedLink = null, needsReimport = false, term = r.term, unplaced = r.unplaced) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(importing = false, message = fail(e)) }
            }
        }
    }

    /** An unplaced class given a stop: added by hand at that stop, as the account page does. */
    fun place(u: sh.rcn.terminus.Unplaced, to: String) {
        edit { it.addManual(sh.rcn.terminus.Trip(u.day, u.arriveByMin, u.endMin, to, "${u.module} @ ${u.venue.substringBefore('-')}", u.venue)) }
        skip(u)
    }

    fun skip(u: sh.rcn.terminus.Unplaced) = _state.update { it.copy(unplaced = it.unplaced - u) }

    /** NUSMods' Share sheet, pointed at terminus. */
    fun shared(link: String) = _state.update { it.copy(sharedLink = link) }

    fun dismissShared() = _state.update { it.copy(sharedLink = null) }

    /** Setup finished or skipped: never shown again, on any device. */
    /**
     * The account's language and this phone's: a language picked here before
     * the account had one (on the welcome screen) goes to the account; one
     * chosen on another device since is applied here.
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

    fun finishSetup() {
        store.needsSetup = false
        val p = _state.value.profile
        if (p != null && "onboarding" !in p.seen) edit { it.markSeen("onboarding") }
    }

    /* ---------- signing in ---------- */

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
        viewModelScope.launch {
            try {
                val p = Api(null).signInCode(r, code)
                if (p.status == "approved" && p.token != null && p.email != null) {
                    pollJob?.cancel()
                    approved(p.token, p.email, p.outcome, onSignedIn)
                }
                _state.update { it.copy(busy = false) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, message = fail(e)) }
            }
        }
    }

    fun cancelSignIn() {
        pollJob?.cancel()
        request = null
        _state.update { it.copy(signIn = null, busy = false) }
    }

    /**
     * Emails an approval link. Sent with this phone's anonymous token (if it
     * has one), so its setup is kept or offered when the account has its own.
     */
    fun sendSignIn(email: String, onSignedIn: () -> Unit) {
        if (_state.value.busy) return
        _state.update { it.copy(busy = true, message = null) }
        viewModelScope.launch {
            try {
                anonToken = store.token
                val r = api().signInStart(email.trim(), deviceName())
                request = r
                _state.update { it.copy(busy = false, signIn = SignIn.Waiting(email.trim(), r.match)) }
                poll(onSignedIn)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, message = fail(e)) }
            }
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
                val p = try {
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
            approvedToken = token
            _state.update { it.copy(signIn = SignIn.Choose(email)) }
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
        viewModelScope.launch {
            try {
                if (anon != null) Api(token).merge(anon, keepPhone)
                signedIn(token, email, onSignedIn)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, message = fail(e)) }
            }
        }
    }

    private fun signedIn(token: String, email: String, onSignedIn: () -> Unit) {
        store.token = token
        store.email = email
        approvedToken = null
        anonToken = null
        _state.update { it.copy(signIn = null, busy = false, email = email, message = L.s(R.string.signed_in_as, email)) }
        viewModelScope.launch {
            // A new account, or one that was never set up, goes through setup.
            val me = runCatching { Api(token).me() }.getOrNull()
            store.needsSetup = me?.needsSetup == true
            refresh()
            onSignedIn()
        }
    }

    /* ---------- trip choices (phase 3) ---------- */

    fun loadChoices() {
        viewModelScope.launch {
            runCatching { api().choices() }
                .onSuccess { (c, history) -> _state.update { it.copy(choices = c, history = history) } }
        }
    }

    fun undoChoice(c: sh.rcn.terminus.TripChoice) {
        viewModelScope.launch {
            runCatching { api().choice("undo", trip = c.trip, pref = c.pref) }
                .onSuccess { list -> _state.update { it.copy(choices = list) } }
                .onFailure { e -> _state.update { it.copy(message = fail(e as Exception)) } }
        }
    }

    fun clearHistory() {
        viewModelScope.launch {
            runCatching { api().clearHistory() }
                .onSuccess { _state.update { it.copy(history = 0, message = L.s(R.string.history_cleared)) } }
                .onFailure { e -> _state.update { it.copy(message = fail(e as Exception)) } }
        }
    }



    /* ---------- feedback, your data ---------- */

    /** Send feedback; [onSent] clears the box once it's gone. */
    fun sendFeedback(note: String, onSent: () -> Unit) {
        viewModelScope.launch {
            _state.update { it.copy(busy = true) }
            try {
                api().feedback(note.trim(), BuildConfig.VERSION_NAME)
                _state.update { it.copy(busy = false, message = L.s(R.string.feedback_thanks)) }
                onSent()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(busy = false, message = fail(e)) }
            }
        }
    }

    /** Download my data, into the file the person picked. */
    fun exportTo(uri: android.net.Uri) {
        viewModelScope.launch {
            try {
                val json = api().export().toString(2)
                withContext(Dispatchers.IO) {
                    getApplication<Application>().contentResolver.openOutputStream(uri)?.use { it.write(json.toByteArray()) }
                }
                _state.update { it.copy(message = L.s(R.string.export_saved)) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(message = fail(e)) }
            }
        }
    }

    /* ---------- devices ---------- */

    fun loadDevices() {
        viewModelScope.launch {
            runCatching { api().devices() }
                .onSuccess { d -> _state.update { it.copy(devices = d) } }
                .onFailure { e -> _state.update { it.copy(message = fail(e as Exception)) } }
        }
    }

    fun newPairCode() {
        viewModelScope.launch {
            try {
                val code = api().pairCode()
                _state.update { it.copy(pairCode = code) }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(message = fail(e)) }
            }
        }
    }

    fun closePairCode() {
        _state.update { it.copy(pairCode = null) }
        loadDevices()
    }

    fun removeDevice(d: Device, onSelf: () -> Unit) {
        viewModelScope.launch {
            try {
                api().removeDevice(d.id)
                if (d.current) onSelf() else loadDevices()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(message = fail(e)) }
            }
        }
    }

    /** For an account with no email: everything goes, then the app starts over. */
    fun deleteAccount(onDone: () -> Unit) {
        viewModelScope.launch {
            try {
                api().deleteAccount()
                reset()
                onDone()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(message = fail(e)) }
            }
        }
    }

    /** After signing out: forget everything about the account. */
    fun reset() {
        pollJob?.cancel()
        _state.value = AccountState()
    }
}
