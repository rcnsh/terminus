package sh.rcn.terminus

import org.json.JSONArray
import org.json.JSONObject

/**
 * The Map tab's data: stops and routes from `/campus`, live buses from
 * `/buses`, and the GeoJSON the map draws from them. Plain JSON in and out,
 * so it's tested on the JVM (MapDataTest).
 */

/** A stop on the map, with the services that call there. */
data class MapStop(val code: String, val name: String, val lat: Double, val lon: Double, val services: List<String>)

/** A service: its colour (ARGB) and its path along the roads, as [lon, lat] pairs. */
data class MapRoute(val svc: String, val color: Long, val line: List<DoubleArray>) {
    /** [west, south, east, north] of the line. */
    fun bounds(): DoubleArray = doubleArrayOf(line.minOf { it[0] }, line.minOf { it[1] }, line.maxOf { it[0] }, line.maxOf { it[1] })
}

data class CampusMap(val stops: List<MapStop>, val routes: Map<String, MapRoute>) {
    /** The services in pill order: A1, A2, D1, … */
    val services: List<String> get() = routes.keys.sorted()

    fun stop(code: String) = stops.firstOrNull { it.code == code }

    /** [west, south, east, north] of the main campus (not P's trip to the Botanic Gardens). */
    fun coreBounds(core: Set<String>): DoubleArray {
        val pts = stops.filter { it.code in core }.ifEmpty { stops }
        return doubleArrayOf(pts.minOf { it.lon }, pts.minOf { it.lat }, pts.maxOf { it.lon }, pts.maxOf { it.lat })
    }

    companion object {
        /** The stops and routes from `/campus`; the core stops' codes come back alongside. */
        fun parse(o: JSONObject): Pair<CampusMap, Set<String>> {
            val s = o.getJSONArray("stops")
            val core = mutableSetOf<String>()
            val stops = (0 until s.length()).map { i ->
                val x = s.getJSONObject(i)
                if (x.optBoolean("core", true)) core += x.getString("code")
                MapStop(x.getString("code"), x.optString("name", x.getString("code")), x.getDouble("lat"), x.getDouble("lon"), x.optJSONArray("services").stringList())
            }
            val r = o.getJSONObject("routes")
            val routes = r.keys().asSequence().associateWith { svc ->
                val x = r.getJSONObject(svc)
                val line = x.optJSONArray("line") ?: JSONArray()
                MapRoute(svc, parseColor(x.optString("color")), (0 until line.length()).map { i -> line.getJSONArray(i).let { p -> doubleArrayOf(p.getDouble(0), p.getDouble(1)) } })
            }.filterValues { it.line.size >= 2 }
            return CampusMap(stops, routes) to core
        }
    }
}

/** "#e53935" -> 0xFFE53935; grey for anything else. */
fun parseColor(hex: String?): Long {
    val h = hex?.removePrefix("#")
    return if (h != null && h.length == 6 && h.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) 0xFF000000L or h.toLong(16) else 0xFF8A939CL
}

/** A bus on the map, as `/buses` gives it: no plate, an id stable while it runs. */
data class LiveBus(
    val id: String,
    val lat: Double,
    val lon: Double,
    val heading: Double?,
    val moving: Boolean,
    val crowd: String?,
    val nextStop: String?,
)

/** One service's buses. [available] false: the feed couldn't be reached, which isn't "no buses". */
data class BusList(val svc: String, val available: Boolean, val buses: List<LiveBus>) {
    companion object {
        fun parse(o: JSONObject): BusList {
            val a = o.optJSONArray("buses") ?: JSONArray()
            return BusList(
                o.getString("svc"),
                o.optBoolean("available"),
                (0 until a.length()).map { i ->
                    val b = a.getJSONObject(i)
                    LiveBus(
                        id = b.getString("id"),
                        lat = b.getDouble("lat"),
                        lon = b.getDouble("lon"),
                        heading = if (b.isNull("heading")) null else b.optDouble("heading"),
                        moving = b.optBoolean("moving"),
                        crowd = b.optString("crowd").takeIf { !b.isNull("crowd") && it.isNotEmpty() },
                        nextStop = b.optJSONObject("nextStop")?.optString("name")?.ifEmpty { null },
                    )
                },
            )
        }
    }
}

/** A stop's board from `/arrivals`. [available] false: no times from the feed. */
data class StopBoard(val available: Boolean, val rows: List<BoardRow>) {
    companion object {
        fun parse(o: JSONObject): StopBoard {
            val b = o.optJSONArray("board") ?: JSONArray()
            val rows = (0 until b.length()).map { i ->
                val r = b.getJSONObject(i)
                BoardRow(r.getString("svc"), if (r.isNull("etaS")) null else r.getInt("etaS"), r.optString("quality"))
            }
            return StopBoard(o.optBoolean("available"), rows.filter { it.etaS != null })
        }
    }
}

/** GeoJSON for the map's sources. */
object MapGeoJson {
    fun routes(campus: CampusMap): String = collection(
        campus.routes.values.map { r ->
            feature(
                JSONObject().put("type", "LineString").put("coordinates", JSONArray(r.line.map { JSONArray().put(it[0]).put(it[1]) })),
                JSONObject().put("svc", r.svc).put("color", hex(r.color)),
            )
        },
    )

    /** `services` as " A1 D2 ": spaces round each, so K never matches inside another code. */
    fun stops(campus: CampusMap): String = collection(
        campus.stops.map { s -> point(s.lon, s.lat, JSONObject().put("code", s.code).put("name", s.name).put("services", " ${s.services.joinToString(" ")} ")) },
    )

    fun buses(svc: String, color: Long, buses: List<LiveBus>): String = collection(
        buses.map { b ->
            point(b.lon, b.lat, JSONObject().put("id", b.id).put("svc", svc).put("color", hex(color)).put("heading", b.heading ?: 0.0).put("moving", b.moving && b.heading != null))
        },
    )

    fun me(lat: Double, lon: Double): String = collection(listOf(point(lon, lat, JSONObject())))

    val EMPTY: String = collection(emptyList())

    private fun hex(argb: Long) = "#%06x".format(argb and 0xFFFFFF)

    private fun point(lon: Double, lat: Double, props: JSONObject) =
        feature(JSONObject().put("type", "Point").put("coordinates", JSONArray().put(lon).put(lat)), props)

    private fun feature(geometry: JSONObject, props: JSONObject) = JSONObject().put("type", "Feature").put("geometry", geometry).put("properties", props)

    private fun collection(features: List<JSONObject>) = JSONObject().put("type", "FeatureCollection").put("features", JSONArray(features)).toString()
}

/** Each bus where it is [k] (0..1) of the way from [from] to [to]; new buses appear where they are. */
fun glide(from: Map<String, LiveBus>, to: List<LiveBus>, k: Float): List<LiveBus> = to.map { b ->
    val f = from[b.id] ?: return@map b
    b.copy(lat = f.lat + (b.lat - f.lat) * k, lon = f.lon + (b.lon - f.lon) * k)
}

private fun JSONArray?.stringList(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }
