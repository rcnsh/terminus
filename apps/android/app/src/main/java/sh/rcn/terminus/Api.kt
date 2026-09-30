package sh.rcn.terminus

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

data class Place(val key: String, val label: String)

/** `/me/next`. label and detail are display-ready; show them verbatim. */
data class NextAnswer(
    val label: String,
    val detail: String,
    val alt: String?,
    val stopName: String,
    val quality: String,
    val asOf: String,
    val mode: String,
    val destLabel: String?,
    val why: String?,
    val places: List<Place>,
    /** When the bus leaves, epoch ms. Clients count down from this. */
    val departsAtMs: Long?,
    /** For a class: "on-time" | "tight" | "late", and its display text. */
    val timingStatus: String?,
    val timingText: String?,
    /** Planned answers: when the plan changes by itself (a class starts, the day ends). */
    val refreshAtMs: Long? = null,
    /** Already at the destination: no bus, no countdown. */
    val arrived: Boolean = false,
    /** The latest time to set off, epoch ms; for a class, the latest that's still on time. */
    val leaveAtMs: Long? = null,
    /** Rests on a headway, not a live time: shown with a "~". */
    val leaveEstimated: Boolean = false,
    /** Why leave-by is earlier than it could be ("D2 is often packed…"). Shown verbatim. */
    val leaveNote: String? = null,
    /** For a class, when it starts, epoch ms. */
    val classAtMs: Long? = null,
    /** Display-ready text from the server; null only in an answer cached before 1.3.6. */
    val card: Card? = null,
) {
    /** The server's card (card.ts): every line below is worded there, once. */
    val isClassPlan: Boolean get() = card?.kind == "class"

    /** No classes today (or none left): nothing to catch, said plainly. */
    val isFree: Boolean get() = mode == "free"

    /** The trip's phase, when one is in progress ("On your way"). */
    val phaseText: String? get() = card?.phaseText

    /** "Leave by ~09:38", or "Leave now" once it has passed: the only part that ticks. */
    fun leaveHeadline(now: Long): String? {
        val at = leaveAtMs ?: return null
        return if (now >= at) "Leave now" else card?.leaveBy
    }

    /** Class: "Catch the ~09:41 D2 at PGP", or "Walk there". */
    val catchHow: String? get() = card?.catch
    /** Class: "Arrive ~09:55 · 3 min early". */
    val catchArrive: String? get() = card?.arrive
    /** Class: both on one line, for the widget and notifications. */
    val catchLine: String? get() = card?.catchLine
    /** Whether the leave-by trip misses the class start. */
    val leaveLate: Boolean get() = card?.late ?: false
    /** The headline bus, when it's not the one to wait for. */
    val goNowLine: String? get() = card?.goNow
    /** "Quiet" / "Filling" / "Packed". */
    val crowdText: String? get() = card?.crowd
    /** "Timetable estimate", "Live data a few minutes old", "No live data". */
    val qualityText: String? get() = card?.quality

    /** Other trips: "Leave by 09:38 · catch the 09:41 D2 at PGP". */
    fun leaveText(now: Long): String? {
        val head = leaveHeadline(now) ?: return null
        return card?.leaveVia?.let { "$head · $it" } ?: head
    }

    /** "D2 · 09:42" when there's a departure time; otherwise the label as sent.
     *  A timetable estimate gets a "~": it is not a live time. */
    fun clockLabel(format: (Long) -> String): String {
        val at = departsAtMs ?: return label
        if (quality == "unknown" || quality == "ended") return label
        return "${label.substringBefore(" · ")} · ${if (quality == "scheduled") "~" else ""}${format(at)}"
    }

    companion object {
        fun parse(o: JSONObject): NextAnswer = try {
            parseOrThrow(o)
        } catch (e: org.json.JSONException) {
            throw ParseError(e.message ?: "bad answer")
        }

        private fun parseOrThrow(o: JSONObject): NextAnswer {
            val dest = o.optJSONObject("dest")
            val places = o.optJSONArray("places") ?: JSONArray()
            return NextAnswer(
                label = o.getString("label"),
                detail = o.optString("detail"),
                alt = o.optStringOrNull("alt"),
                stopName = o.optJSONObject("stop")?.optString("name").orEmpty(),
                quality = o.optString("quality", "unknown"),
                asOf = o.optString("asOf"),
                mode = o.optString("mode", "trip"),
                destLabel = dest?.optStringOrNull("label"),
                why = dest?.optStringOrNull("why"),
                places = (0 until places.length()).map {
                    val p = places.getJSONObject(it)
                    Place(p.getString("key"), p.getString("label"))
                },
                departsAtMs = o.optStringOrNull("departsAt")?.let(::parseInstant),
                refreshAtMs = o.optStringOrNull("refreshAt")?.let(::parseInstant),
                arrived = o.optBoolean("arrived", false),
                leaveAtMs = o.optJSONObject("leave")?.optStringOrNull("at")?.let(::parseInstant),
                leaveEstimated = o.optJSONObject("leave")?.optBoolean("estimated", false) ?: false,
                leaveNote = o.optJSONObject("leave")?.optStringOrNull("note"),
                classAtMs = o.optJSONObject("timing")?.optStringOrNull("classAt")?.let(::parseInstant),
                timingStatus = o.optJSONObject("timing")?.optStringOrNull("status"),
                timingText = o.optJSONObject("timing")?.optStringOrNull("text"),
                card = o.optJSONObject("card")?.let(Card::parse),
            )
        }
    }
}

/** `card` in /me/next (apps/api/src/card.ts). Lines are shown verbatim. */
data class Card(
    val kind: String,
    /** Dim from this instant, epoch ms. */
    val staleAtMs: Long?,
    val crowd: String?,
    val quality: String?,
    val leaveBy: String?,
    val leaveVia: String?,
    val catch: String?,
    val arrive: String?,
    val catchLine: String?,
    val late: Boolean,
    val goNow: String?,
    val note: String?,
    val estimate: String?,
    /** v2: where the trip is: idle, due, heading, waiting, riding, missed, arrived. */
    val phase: String = "idle",
    /** "On your way", above the answer. Null when idle. */
    val phaseText: String? = null,
    /** 12 characters: a tile or a glance. */
    val glance: String? = null,
    /** One line: a collapsed notification, a compact widget. */
    val line: String? = null,
    /** Buttons the server decided to show; tapping one sends it to /me/signal. */
    val actions: List<CardAction> = emptyList(),
    /** "Last D2 from UTown in 18 min". */
    val warning: String? = null,
    /** When this card changes by itself: refresh then. */
    val nextChangeAtMs: Long? = null,
    /** "On the 9:41 D2?": from the bus's departure until the class starts, unanswered. */
    val ask: CardAsk? = null,
    /** The question was ignored five trips running; Settings can turn it back on. */
    val askMuted: Boolean = false,
    /** False when the user turned reminders off for this class: no leave notification. */
    val remind: Boolean = true,
    /** "Leave one bus earlier for CS2030?", accepted or turned down with /me/choice. */
    val suggestion: Suggestion? = null,
) {
    companion object {
        fun parse(o: JSONObject) = Card(
            kind = o.optString("kind", "trip"),
            staleAtMs = o.optStringOrNull("staleAt")?.let(::parseInstant),
            crowd = o.optStringOrNull("crowd"),
            quality = o.optStringOrNull("quality"),
            leaveBy = o.optStringOrNull("leaveBy"),
            leaveVia = o.optStringOrNull("leaveVia"),
            catch = o.optStringOrNull("catch"),
            arrive = o.optStringOrNull("arrive"),
            catchLine = o.optStringOrNull("catchLine"),
            late = o.optBoolean("late", false),
            goNow = o.optStringOrNull("goNow"),
            note = o.optStringOrNull("note"),
            estimate = o.optStringOrNull("estimate"),
            phase = o.optString("phase", "idle"),
            phaseText = o.optStringOrNull("phaseText"),
            glance = o.optStringOrNull("glance"),
            line = o.optStringOrNull("line"),
            actions = o.optJSONArray("actions")?.let { a ->
                (0 until a.length()).map { a.getJSONObject(it).let { x -> CardAction(x.getString("id"), x.getString("label"), x.getString("trip")) } }
            }.orEmpty(),
            warning = o.optStringOrNull("warning"),
            nextChangeAtMs = o.optStringOrNull("nextChangeAt")?.let(::parseInstant),
            ask = o.optJSONObject("ask")?.let { a ->
                CardAsk(a.getString("trip"), a.getString("question"), parseActions(a.optJSONArray("actions")))
            },
            askMuted = o.optBoolean("askMuted", false),
            remind = o.optBoolean("remind", true),
            suggestion = o.optJSONObject("suggestion")?.let { s ->
                Suggestion(s.getString("id"), s.getString("text"), s.getString("accept"), s.getString("dismiss"))
            },
        )

        private fun parseActions(a: JSONArray?): List<CardAction> =
            a?.let { (0 until it.length()).map { i -> it.getJSONObject(i).let { x -> CardAction(x.getString("id"), x.getString("label"), x.getString("trip")) } } }.orEmpty()
    }
}

/** The question at the bus's departure, with its buttons (On it · Missed it · Not going). */
data class CardAsk(val trip: String, val question: String, val actions: List<CardAction>)

/** Something terminus learned and offers to change; `id` goes back to /me/choice. */
data class Suggestion(val id: String, val text: String, val accept: String, val dismiss: String)

/** A class you chose to leave a bus earlier for (`earlier`) or get no reminders for (`quiet`). */
data class TripChoice(val trip: String, val pref: String, val label: String?)

/** A button on the card: `id` is the signal to send, `trip` which trip it's about. */
data class CardAction(val id: String, val label: String, val trip: String)

/** `/me/day`: today's timeline. */
data class DayItem(
    val kind: String,
    val key: String,
    val label: String,
    /** done | now | next | later | skipped */
    val status: String,
    val fromName: String?,
    val toName: String,
    val startsAtMs: Long,
    val endsAtMs: Long?,
    val leaveAtMs: Long?,
    val leaveEstimated: Boolean,
    val svc: String?,
    val timingText: String?,
    val timingStatus: String?,
)

data class DayPlan(val items: List<DayItem>, val note: String?) {
    companion object {
        fun parse(o: JSONObject): DayPlan {
            val a = o.optJSONArray("items") ?: JSONArray()
            return DayPlan(
                items = (0 until a.length()).map {
                    val x = a.getJSONObject(it)
                    val leave = x.optJSONObject("leave")
                    val timing = x.optJSONObject("timing")
                    DayItem(
                        kind = x.optString("kind"),
                        key = x.optString("key"),
                        label = x.optString("label"),
                        status = x.optString("status"),
                        fromName = x.optStringOrNull("fromName"),
                        toName = x.optString("toName"),
                        startsAtMs = parseInstant(x.optString("startsAt")) ?: 0,
                        endsAtMs = x.optStringOrNull("endsAt")?.let(::parseInstant),
                        leaveAtMs = leave?.optStringOrNull("at")?.let(::parseInstant),
                        leaveEstimated = leave?.optBoolean("estimated", false) ?: false,
                        svc = leave?.optStringOrNull("svc"),
                        timingText = timing?.optStringOrNull("text"),
                        timingStatus = timing?.optStringOrNull("status"),
                    )
                },
                note = o.optStringOrNull("note"),
            )
        }
    }
}

data class BoardRow(val svc: String, val etaS: Int?, val quality: String)

data class NearbyStop(
    val code: String,
    val name: String,
    val walkS: Int,
    val available: Boolean,
    val board: List<BoardRow>,
)

data class Destination(
    val code: String,
    val label: String,
    val stopCode: String,
    val kind: String,
    /** Metres on foot from the stop; null for a stop. */
    val walkM: Int? = null,
    /** Other names people search for, lower case ("soc", "mrt"). */
    val aliases: List<String> = emptyList(),
    /** A landmark's every stop; the router takes the quicker. */
    val stops: List<String> = emptyList(),
    /** What a landmark is ("Food court"). */
    val detail: String? = null,
)

/**
 * The destination search, same rules as the account page: exact, then starts
 * with, then a word starts with, then contains; stops before buildings before
 * rooms, and rooms only once two characters say which.
 */
fun rankDestinations(all: List<Destination>, query: String, max: Int = 8): List<Destination> {
    val q = query.trim().lowercase()
    if (q.isEmpty()) return emptyList()
    val norm = { s: String -> s.lowercase().replace(Regex("[\\s\\-_]+"), "") }
    val nq = norm(q)
    val kinds = listOf("stop", "landmark", "building", "room")
    fun score(d: Destination): Int {
        val names = listOf(d.code.lowercase(), d.label.lowercase()) + d.aliases
        return when {
            names.any { it == q } || norm(d.code) == nq -> 0
            names.any { it.startsWith(q) } || norm(d.code).startsWith(nq) -> 1
            names.any { n -> n.split(Regex("[\\s()·,/&-]+")).any { it.isNotEmpty() && it.startsWith(q) } } -> 2
            names.any { it.contains(q) } -> 3
            else -> -1
        }
    }
    return all.asSequence()
        .filter { it.kind != "room" || q.length >= 2 }
        .map { it to score(it) }
        .filter { it.second >= 0 }
        .sortedWith(compareBy({ it.second }, { kinds.indexOf(it.first.kind) }, { it.first.label.length }))
        .take(max)
        .map { it.first }
        .toList()
}

/** What the user asked for: the planned trip, a saved place, or any stop/venue. */
sealed interface Target {
    data object Plan : Target
    data class SavedPlace(val key: String) : Target
    data class Code(val code: String, val label: String) : Target
}

class ApiError(val status: Int, message: String) : IOException(message)

/** The answer arrived but isn't what this version understands. Not a network problem. */
class ParseError(message: String) : Exception(message)

/** `fast` is for the widget: a tap runs inside a broadcast, which can be killed. */
class Api(private val token: String?, private val fast: Boolean = false, private val hour12: Boolean = false) {

    suspend fun pair(code: String, name: String): String {
        val body = JSONObject().put("code", code).put("name", name)
        return request("POST", "/pair", body).getString("token")
    }

    /** First launch: an account with no email, so the app works before any sign-in. */
    suspend fun anon(name: String): String =
        request("POST", "/auth/anon", JSONObject().put("name", name).put("platform", "android")).getString("token")

    suspend fun me(): Me = Me.parse(request("GET", "/me"))

    /** The whole profile as the server keeps it; edited and sent back whole. */
    suspend fun profile(): JSONObject = request("GET", "/me/profile")

    suspend fun saveProfile(profile: JSONObject): JSONObject = request("PUT", "/me/profile", profile)

    /** Imports a NUSMods share link; the server replaces the imported classes only if it all worked. */
    suspend fun import(share: String): ImportResult = ImportResult.parse(request("POST", "/me/import", JSONObject().put("share", share)))

    /** Stops and residences, for the home and place pickers. */
    suspend fun campus(): Campus = Campus.parse(request("GET", "/campus"))

    /** Starts a sign-in approved from the email; send it with this device's anonymous token to keep its setup. */
    suspend fun signInStart(email: String, name: String): SignInRequest {
        val o = request("POST", "/auth/app/start", JSONObject().put("email", email).put("name", name))
        return SignInRequest(o.getString("request"), o.getString("poll"), o.getInt("match"))
    }

    suspend fun signInPoll(r: SignInRequest): SignInPoll {
        val o = request("POST", "/auth/app/poll", JSONObject().put("request", r.request).put("poll", r.poll))
        return SignInPoll(o.getString("status"), o.optStringOrNull("token"), o.optStringOrNull("email"), o.optStringOrNull("outcome"))
    }

    /** The code from the email, typed here. A wrong one throws with the server's message. */
    suspend fun signInCode(r: SignInRequest, code: String): SignInPoll {
        val o = request("POST", "/auth/app/code", JSONObject().put("request", r.request).put("poll", r.poll).put("code", code))
        return SignInPoll(o.getString("status"), o.optStringOrNull("token"), o.optStringOrNull("email"), o.optStringOrNull("outcome"))
    }

    /** After a "choose" outcome: which setup to keep. `anon` is the device's old token. */
    suspend fun merge(anon: String, keepDevice: Boolean) {
        request("POST", "/auth/app/merge", JSONObject().put("anon", anon).put("keep", if (keepDevice) "device" else "account"))
    }

    /** A code another device can pair with (accounts with an email only). */
    suspend fun pairCode(): String = request("POST", "/me/pair-code", JSONObject()).getString("code")

    suspend fun devices(): List<Device> {
        val list = request("GET", "/me/devices").getJSONArray("devices")
        return (0 until list.length()).map {
            val d = list.getJSONObject(it)
            Device(
                d.getString("id"), d.optStringOrNull("name") ?: "Device", d.optStringOrNull("platform"),
                d.optLong("created"), d.optLong("lastSeen"), d.optBoolean("current", false),
            )
        }
    }

    suspend fun removeDevice(id: String) {
        request("DELETE", "/me/devices/${enc(id)}")
    }

    /** Only for an account with no email: one with an email is deleted from the account page. */
    suspend fun deleteAccount() {
        request("DELETE", "/me")
    }

    suspend fun next(target: Target, lat: Double?, lon: Double?): NextAnswer =
        NextAnswer.parse(nextJson(target, lat, lon))

    /** Raw form, for the widget cache. */
    suspend fun nextJson(target: Target, lat: Double?, lon: Double?): JSONObject {
        val q = buildList {
            if (lat != null && lon != null) {
                add("lat=${coord(lat)}")
                add("lon=${coord(lon)}")
            }
            when (target) {
                Target.Plan -> {}
                is Target.SavedPlace -> add("place=${enc(target.key)}")
                is Target.Code -> add("to=${enc(target.code)}")
            }
            // The card's clock times, in this phone's 12- or 24-hour style.
            if (hour12) add("h12=1")
        }
        return request("GET", "/me/next" + query(q))
    }

    suspend fun nearby(lat: Double?, lon: Double?): List<NearbyStop> {
        val q = if (lat != null && lon != null) listOf("lat=${coord(lat)}", "lon=${coord(lon)}") else emptyList()
        val stops = request("GET", "/me/nearby" + query(q)).getJSONArray("stops")
        return (0 until stops.length()).map { i ->
            val s = stops.getJSONObject(i)
            val board = s.getJSONArray("board")
            NearbyStop(
                code = s.getJSONObject("stop").getString("code"),
                name = s.getJSONObject("stop").getString("name"),
                walkS = s.optInt("walkS"),
                available = s.optBoolean("available", true),
                board = (0 until board.length()).map { j ->
                    val r = board.getJSONObject(j)
                    BoardRow(r.getString("svc"), if (r.isNull("etaS")) null else r.getInt("etaS"), r.optString("quality"))
                },
            )
        }
    }

    suspend fun destinations(): List<Destination> {
        val list = request("GET", "/campus").getJSONArray("destinations")
        return (0 until list.length()).map { parseDestination(list.getJSONObject(it)) }
    }

    /** Something that happened on the trip ("boarded", "missed", ...). Answers with the new /me/next. */
    suspend fun signal(kind: String, trip: String?, lat: Double? = null, lon: Double? = null): JSONObject {
        val body = JSONObject().put("kind", kind)
        trip?.let { body.put("trip", it) }
        if (lat != null && lon != null) body.put("lat", coord(lat).toDouble()).put("lon", coord(lon).toDouble())
        return request("POST", "/me/signal" + if (hour12) "?h12=1" else "", body)
    }

    /** This phone's Firebase token, so the server can say when the card changes. */
    suspend fun registerPush(token: String) {
        request("POST", "/me/push", JSONObject().put("token", token))
    }

    /** A suggestion accepted or turned down (`id`), or a choice undone (`trip` and `pref`). */
    suspend fun choice(choice: String, id: String? = null, trip: String? = null, pref: String? = null): List<TripChoice> {
        val body = JSONObject().put("choice", choice)
        id?.let { body.put("id", it) }
        trip?.let { body.put("trip", it) }
        pref?.let { body.put("pref", it) }
        return parseChoices(request("POST", "/me/choice", body))
    }

    /** Classes with a bus earlier or no reminders, and whether the question is muted. */
    suspend fun choices(): Pair<List<TripChoice>, Boolean> {
        val o = request("GET", "/me/choices")
        return parseChoices(o) to o.optBoolean("askMuted", false)
    }

    /** "Ask if I caught the bus" back on. */
    suspend fun askAgain() {
        request("POST", "/me/ask")
    }

    private fun parseChoices(o: JSONObject): List<TripChoice> {
        val a = o.optJSONArray("choices") ?: return emptyList()
        return (0 until a.length()).map { a.getJSONObject(it).let { c -> TripChoice(c.getString("trip"), c.getString("pref"), c.optStringOrNull("label")) } }
    }

    /** Today's timeline. */
    suspend fun day(): DayPlan = DayPlan.parse(request("GET", "/me/day" + if (hour12) "?h12=1" else ""))

    /** Whose account a pairing code belongs to (masked), without spending it. */
    suspend fun pairCheck(code: String): String =
        request("POST", "/pair/check", JSONObject().put("code", code)).getString("account")

    /** The released version, from /download/latest.json. */
    suspend fun latestVersion(): String = request("GET", "/download/latest.json").getString("version")

    /** "Is this wrong?": the answer as the server sent it, and a note. */
    suspend fun report(note: String, answer: JSONObject?, appVersion: String) {
        val body = JSONObject().put("kind", "wrong").put("note", note).put("platform", "android").put("appVersion", appVersion)
        answer?.let { body.put("context", it) }
        request("POST", "/me/feedback", body)
    }

    /** Ends this device's session on the server. */
    suspend fun logout() {
        request("POST", "/auth/logout", JSONObject())
    }

    private suspend fun request(method: String, path: String, body: JSONObject? = null): JSONObject =
        withContext(Dispatchers.IO) {
            val conn = URL(BuildConfig.API_BASE + path).openConnection() as HttpURLConnection
            try {
                conn.requestMethod = method
                conn.connectTimeout = if (fast) 4_000 else 8_000
                conn.readTimeout = if (fast) 5_000 else 10_000
                conn.setRequestProperty("accept", "application/json")
                // So the server can tell apps and versions apart (the User-Agent only says Dalvik).
                conn.setRequestProperty("x-terminus-client", CLIENT)
                token?.let { conn.setRequestProperty("authorization", "Bearer $it") }
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("content-type", "application/json")
                    conn.outputStream.use { it.write(body.toString().toByteArray()) }
                }
                val status = conn.responseCode
                val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = runCatching { JSONObject(text) }.getOrNull()
                if (status !in 200..299) throw ApiError(status, json?.optString("error", "HTTP $status") ?: "HTTP $status")
                // A 200 that isn't JSON is not "offline": the server said something this version can't read.
                json ?: throw ParseError("not JSON")
            } finally {
                conn.disconnect()
            }
        }

    private fun query(parts: List<String>) = if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

/** `x-terminus-client`: platform and version. */
val CLIENT = "android/${BuildConfig.VERSION_NAME}"

/** `/me`: who this device is signed in as. */
data class Me(val email: String?, val anonymous: Boolean, val needsSetup: Boolean) {
    companion object {
        fun parse(o: JSONObject) = Me(
            email = o.optStringOrNull("email"),
            anonymous = o.optBoolean("anonymous", false),
            needsSetup = o.optStringOrNull("onboarding") != null,
        )
    }
}

data class SignInRequest(val request: String, val poll: String, val match: Int)

/** status: pending | approved | denied | expired. outcome as in applogin.ts. */
data class SignInPoll(val status: String, val token: String?, val email: String?, val outcome: String?)

data class Device(val id: String, val name: String, val platform: String?, val createdMs: Long, val lastSeenMs: Long, val current: Boolean)

data class Stop(val code: String, val name: String, val lat: Double, val lon: Double)

data class Residence(val code: String, val name: String, val stops: List<String>, val walkM: Int)

data class Campus(val stops: List<Stop>, val residences: List<Residence>, val destinations: List<Destination>) {
    fun stopName(code: String) = stops.firstOrNull { it.code == code }?.name ?: code

    companion object {
        fun parse(o: JSONObject): Campus {
            val s = o.getJSONArray("stops")
            val r = o.optJSONArray("residences") ?: JSONArray()
            val d = o.optJSONArray("destinations") ?: JSONArray()
            return Campus(
                stops = (0 until s.length()).map {
                    val x = s.getJSONObject(it)
                    Stop(x.getString("code"), x.optString("name", x.getString("code")), x.optDouble("lat"), x.optDouble("lon"))
                }.sortedBy { it.name },
                residences = (0 until r.length()).map {
                    val x = r.getJSONObject(it)
                    val st = x.getJSONArray("stops")
                    Residence(x.getString("code"), x.getString("name"), (0 until st.length()).map { i -> st.getString(i) }, x.optInt("walkM"))
                }.sortedBy { it.name },
                destinations = (0 until d.length()).map { parseDestination(d.getJSONObject(it)) },
            )
        }
    }
}

/** `/me/import`: what was found, what couldn't be placed, and for which semester. */
data class ImportResult(val profile: JSONObject, val classes: Int, val unresolved: List<String>, val missing: List<String>, val term: String) {
    companion object {
        fun parse(o: JSONObject): ImportResult {
            val profile = o.getJSONObject("profile")
            val un = o.optJSONArray("unresolved") ?: JSONArray()
            val miss = o.optJSONArray("missing") ?: JSONArray()
            return ImportResult(
                profile = profile,
                classes = profile.optJSONArray("trips")?.length() ?: 0,
                unresolved = (0 until un.length()).map { un.getJSONObject(it).let { u -> "${u.optString("module")} at ${u.optString("venue")}" } },
                missing = (0 until miss.length()).map { miss.getString(it) },
                term = o.optString("term"),
            )
        }
    }
}

/** The phone's name, as Settings and the account page show it: "Google Pixel 8". */
fun deviceName(): String =
    "${android.os.Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${android.os.Build.MODEL}".take(40)

/**
 * Four decimals is about 11 m: enough to tell PGP from PGP Foyer, and no
 * more precise than that in URLs that pass through logs.
 */
private fun coord(v: Double) = "%.4f".format(java.util.Locale.ROOT, v)

private fun parseDestination(d: JSONObject) = Destination(
    d.getString("code"), d.getString("label"), d.getString("stopCode"), d.optString("kind"),
    walkM = if (d.has("walkM")) d.optInt("walkM") else null,
    aliases = d.optJSONArray("aliases")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
    stops = d.optJSONArray("stops")?.let { a -> (0 until a.length()).map { a.getString(it) } }.orEmpty(),
    detail = d.optStringOrNull("detail"),
)

private fun parseInstant(s: String): Long? = runCatching { java.time.Instant.parse(s).toEpochMilli() }.getOrNull()

/** The phone shows 12-hour times: ask the server for its card in that style. */
fun hour12(ctx: android.content.Context): Boolean = !android.text.format.DateFormat.is24HourFormat(ctx)

/**
 * "1.0.10" > "1.0.9", and a release is newer than its own pre-release:
 * "2.0.0" > "2.0.0-beta.2" > "2.0.0-beta" > "1.3.10".
 */
fun isNewer(latest: String, current: String): Boolean {
    fun parts(v: String): Pair<List<Int>, List<Int>?> {
        val (num, pre) = v.split('-', limit = 2).let { it[0] to it.getOrNull(1) }
        // "beta.2" -> [2]; "beta" -> [0]. No tag at all ranks above any tag.
        return num.split('.').map { it.toIntOrNull() ?: 0 } to pre?.let { p -> listOf(p.substringAfter('.', "0").toIntOrNull() ?: 0) }
    }
    fun cmp(a: List<Int>, b: List<Int>): Int {
        for (i in 0 until maxOf(a.size, b.size)) {
            val d = a.getOrElse(i) { 0 } - b.getOrElse(i) { 0 }
            if (d != 0) return d
        }
        return 0
    }
    val (an, ap) = parts(latest)
    val (bn, bp) = parts(current)
    val d = cmp(an, bn)
    if (d != 0) return d > 0
    return when {
        ap == null -> bp != null
        bp == null -> false
        else -> cmp(ap, bp) > 0
    }
}

fun JSONObject.optStringOrNull(key: String): String? = if (!has(key) || isNull(key)) null else optString(key)
