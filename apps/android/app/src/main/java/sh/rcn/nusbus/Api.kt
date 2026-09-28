package sh.rcn.nusbus

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
) {
    companion object {
        fun parse(o: JSONObject): NextAnswer {
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

data class Destination(val code: String, val label: String, val stopCode: String, val kind: String)

/** What the user asked for: the planned trip, a saved place, or any stop/venue. */
sealed interface Target {
    data object Plan : Target
    data class SavedPlace(val key: String) : Target
    data class Code(val code: String, val label: String) : Target
}

class ApiError(val status: Int, message: String) : IOException(message)

class Api(private val token: String?) {

    suspend fun pair(code: String, name: String): String {
        val body = JSONObject().put("code", code).put("name", name)
        return request("POST", "/pair", body).getString("token")
    }

    suspend fun next(target: Target, lat: Double?, lon: Double?): NextAnswer =
        NextAnswer.parse(nextJson(target, lat, lon))

    /** Raw form, for the widget cache. */
    suspend fun nextJson(target: Target, lat: Double?, lon: Double?): JSONObject {
        val q = buildList {
            if (lat != null && lon != null) {
                add("lat=$lat")
                add("lon=$lon")
            }
            when (target) {
                Target.Plan -> {}
                is Target.SavedPlace -> add("place=${enc(target.key)}")
                is Target.Code -> add("to=${enc(target.code)}")
            }
        }
        return request("GET", "/me/next" + query(q))
    }

    suspend fun nearby(lat: Double?, lon: Double?): List<NearbyStop> {
        val q = if (lat != null && lon != null) listOf("lat=$lat", "lon=$lon") else emptyList()
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
        return (0 until list.length()).map {
            val d = list.getJSONObject(it)
            Destination(d.getString("code"), d.getString("label"), d.getString("stopCode"), d.optString("kind"))
        }
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
                conn.connectTimeout = 8_000
                conn.readTimeout = 10_000
                conn.setRequestProperty("accept", "application/json")
                token?.let { conn.setRequestProperty("authorization", "Bearer $it") }
                if (body != null) {
                    conn.doOutput = true
                    conn.setRequestProperty("content-type", "application/json")
                    conn.outputStream.use { it.write(body.toString().toByteArray()) }
                }
                val status = conn.responseCode
                val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
                val json = runCatching { JSONObject(text) }.getOrElse { JSONObject() }
                if (status !in 200..299) throw ApiError(status, json.optString("error", "HTTP $status"))
                json
            } finally {
                conn.disconnect()
            }
        }

    private fun query(parts: List<String>) = if (parts.isEmpty()) "" else "?" + parts.joinToString("&")
    private fun enc(s: String) = URLEncoder.encode(s, "UTF-8")
}

fun JSONObject.optStringOrNull(key: String): String? = if (isNull(key)) null else optString(key)
