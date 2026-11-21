package sh.rcn.terminus

import kotlin.math.PI
import kotlin.math.asin
import kotlin.math.atan
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.ln
import kotlin.math.log2
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sinh
import kotlin.math.sqrt
import kotlin.math.tan
import org.json.JSONArray
import org.json.JSONObject

object PanLimit {
    val EXTENT = doubleArrayOf(103.755, 1.28, 103.83, 1.332)
    private const val TILE = 512.0

    fun minZoom(width: Double, height: Double, west: Double = 0.0, south: Double = 0.0): Double =
        max(
            log2((width - west) / (TILE * (x(EXTENT[2]) - x(EXTENT[0])))),
            log2((height - south) / (TILE * (y(EXTENT[1]) - y(EXTENT[3])))),
        )

    fun centre(width: Double, height: Double, zoom: Double, west: Double = 0.0, south: Double = 0.0): DoubleArray {
        val world = TILE * 2.0.pow(zoom)
        val (w, e) = inset(x(EXTENT[0]) - west / world, x(EXTENT[2]), width / 2 / world)
        val (top, bottom) = inset(y(EXTENT[3]), y(EXTENT[1]) + south / world, height / 2 / world)
        return doubleArrayOf(lon(w), lat(bottom), lon(e), lat(top))
    }

    private fun inset(a: Double, b: Double, by: Double): Pair<Double, Double> =
        if (b - a > 2 * by) a + by to b - by else ((a + b) / 2).let { it to it }

    private fun x(lon: Double) = (lon + 180) / 360

    private fun y(lat: Double) = (1 - ln(tan(PI / 4 + lat * PI / 360)) / PI) / 2

    private fun lon(x: Double) = x * 360 - 180

    private fun lat(y: Double) = atan(sinh(PI * (1 - 2 * y))) * 180 / PI
}

data class MapStop(
    val code: String,
    val name: String,
    val lat: Double,
    val lon: Double,
    val services: List<String>,
    val longName: String? = null,
) {
    val fullName: String
        get() = longName ?: name
}

data class ServiceRoute(val svc: String, val seq: List<String>, val loop: Boolean, val name: String? = null, val via: String? = null)

data class MapRoute(val svc: String, val color: Long, val line: List<DoubleArray>, val loop: Boolean = false) {
    fun bounds(): DoubleArray = doubleArrayOf(line.minOf { it[0] }, line.minOf { it[1] }, line.maxOf { it[0] }, line.maxOf { it[1] })

    val path: RoutePath by lazy { RoutePath(line, loop) }
}

class RoutePath(private val line: List<DoubleArray>, loop: Boolean = false) {
    private val cum =
        DoubleArray(line.size).also { c ->
            for (i in 1 until line.size) c[i] = c[i - 1] + haversine(line[i - 1][1], line[i - 1][0], line[i][1], line[i][0])
        }
    val total: Double = cum.lastOrNull() ?: 0.0

    val closed: Boolean = loop && line.size >= 2

    fun pointAt(m: Double): Triple<Double, Double, Double> = pointOn(wrap(m))

    private fun pointOn(at: Double): Triple<Double, Double, Double> {
        var lo = 0
        var hi = cum.size - 1
        while (hi - lo > 1) {
            val mid = (lo + hi) / 2
            if (cum[mid] <= at) lo = mid else hi = mid
        }
        val (aLon, aLat) = line[lo].let { it[0] to it[1] }
        val (bLon, bLat) = line[hi].let { it[0] to it[1] }
        val seg = cum[hi] - cum[lo]
        val t = if (seg > 0) (at - cum[lo]) / seg else 0.0
        return Triple(aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t, bearing(aLat, aLon, bLat, bLon))
    }

    fun slice(a: Double, b: Double): List<DoubleArray>? {
        if (line.size < 2 || !(b > a) || a < 0 || b > total + 1) return null
        fun end(m: Double) = pointOn(m.coerceIn(0.0, total)).let { (lat, lon) -> doubleArrayOf(lon, lat) }
        return listOf(end(a)) + line.filterIndexed { i, _ -> cum[i] > a && cum[i] < b } + listOf(end(b))
    }

    fun wrap(m: Double): Double = if (closed) ((m % total) + total) % total else m.coerceIn(0.0, total)

    fun aheadBy(f: LiveBus, b: LiveBus): Double? {
        val fa = f.along ?: return null
        val ba = b.along ?: return null
        if (line.size < 2 || total <= 0 || fa > total + 1 || ba > total + 1) return null
        var d = ba - fa
        if (closed && d < -total / 2) d += total
        return if (d > 0 && d <= SLIDE_MAX_M) d else null
    }

    companion object {
        const val SLIDE_MAX_M = 1_500.0

        fun haversine(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
            val r = PI / 180
            val s = sin((bLat - aLat) * r / 2).pow(2) + cos(aLat * r) * cos(bLat * r) * sin((bLon - aLon) * r / 2).pow(2)
            return 2 * 6_371_000 * asin(min(1.0, sqrt(s)))
        }

        fun bearing(aLat: Double, aLon: Double, bLat: Double, bLon: Double): Double {
            val r = PI / 180
            val y = sin((bLon - aLon) * r) * cos(bLat * r)
            val x = cos(aLat * r) * sin(bLat * r) - sin(aLat * r) * cos(bLat * r) * cos((bLon - aLon) * r)
            return ((atan2(y, x) / r) % 360 + 360) % 360
        }
    }
}

data class CampusMap(
    val stops: List<MapStop>,
    val routes: Map<String, MapRoute>,
    val serviceCodes: List<String> = routes.keys.sorted(),
    val stopAliases: Map<String, List<String>> = emptyMap(),
    val lines: List<ServiceRoute> = emptyList(),
) {
    val services: List<String>
        get() = routes.keys.sorted()

    fun stop(code: String) = stops.firstOrNull { it.code == code }

    fun nearest(codes: List<String>, lat: Double?, lon: Double?): String? {
        val known = codes.distinct().mapNotNull(::stop)
        if (lat == null || lon == null) return known.firstOrNull()?.code ?: codes.firstOrNull()
        val k = cos(lat * PI / 180)
        return known.minByOrNull { (it.lat - lat).pow(2) + ((it.lon - lon) * k).pow(2) }?.code ?: codes.firstOrNull()
    }

    fun coreBounds(core: Set<String>): DoubleArray {
        val pts = stops.filter { it.code in core }.ifEmpty { stops }
        return doubleArrayOf(pts.minOf { it.lon }, pts.minOf { it.lat }, pts.maxOf { it.lon }, pts.maxOf { it.lat })
    }

    fun coreExtent(core: Set<String>): DoubleArray {
        val b = coreBounds(core)
        if (stops.none { it.code in core }) return b
        val pts = lines.filter { l -> l.seq.isNotEmpty() && l.seq.all { it in core } }.flatMap { routes[it.svc]?.line.orEmpty() }
        return doubleArrayOf(
            minOf(b[0], pts.minOfOrNull { it[0] } ?: b[0]),
            minOf(b[1], pts.minOfOrNull { it[1] } ?: b[1]),
            maxOf(b[2], pts.maxOfOrNull { it[0] } ?: b[2]),
            maxOf(b[3], pts.maxOfOrNull { it[1] } ?: b[3]),
        )
    }

    companion object {
        fun parse(o: JSONObject): Pair<CampusMap, Set<String>> {
            val s = o.getJSONArray("stops")
            val core = mutableSetOf<String>()
            val stops =
                (0 until s.length()).map { i ->
                    val x = s.getJSONObject(i)
                    if (x.optBoolean("core", true)) core += x.getString("code")
                    MapStop(
                        x.getString("code"),
                        x.optString("name", x.getString("code")),
                        x.getDouble("lat"),
                        x.getDouble("lon"),
                        x.optJSONArray("services").stringList(),
                        x.optStringOrNull("longName")?.ifEmpty { null },
                    )
                }
            val r = o.getJSONObject("routes")
            val routes =
                r.keys()
                    .asSequence()
                    .associateWith { svc ->
                        val x = r.getJSONObject(svc)
                        val line = x.optJSONArray("line") ?: JSONArray()
                        MapRoute(
                            svc,
                            parseColor(x.optString("color")),
                            (0 until line.length()).map { i ->
                                line.getJSONArray(i).let { p -> doubleArrayOf(p.getDouble(0), p.getDouble(1)) }
                            },
                            x.optBoolean("loop"),
                        )
                    }
                    .filterValues { it.line.size >= 2 }
            return CampusMap(stops, routes, serviceCodes(r), stopAliases(o.optJSONArray("destinations")), serviceRoutes(r)) to core
        }

        fun serviceRoutes(routes: JSONObject): List<ServiceRoute> =
            routes.keys().asSequence().toList().map { svc ->
                val x = routes.optJSONObject(svc) ?: JSONObject()
                ServiceRoute(
                    svc,
                    x.optJSONArray("seq").stringList(),
                    x.optBoolean("loop"),
                    x.optStringOrNull("name")?.ifEmpty { null },
                    x.optStringOrNull("via")?.ifEmpty { null },
                )
            }

        fun serviceCodes(routes: JSONObject): List<String> = routes.keys().asSequence().toList().sorted()

        fun stopAliases(destinations: JSONArray?): Map<String, List<String>> {
            if (destinations == null) return emptyMap()
            return (0 until destinations.length())
                .mapNotNull { destinations.optJSONObject(it) }
                .filter { it.optString("kind") == "stop" }
                .associate { d -> d.optString("code") to d.optJSONArray("aliases").stringList() }
        }
    }
}

fun parseColor(hex: String?): Long {
    val h = hex?.removePrefix("#")
    return if (h != null && h.length == 6 && h.all { it.isDigit() || it.lowercaseChar() in 'a'..'f' }) 0xFF000000L or h.toLong(16)
    else 0xFF8A939CL
}

data class LiveBus(
    val id: String,
    val lat: Double,
    val lon: Double,
    val heading: Double?,
    val moving: Boolean,
    val crowd: String?,
    val nextStop: String?,
    val along: Double? = null,
    val plate: String? = null,
    val at: String? = null,
    val slot: Int = 0,
    val stretch: Stretch? = null,
    val upcoming: List<String> = emptyList(),
    val towards: String? = null,
    val atCode: String? = null,
    val passedCode: String? = null,
    val upcomingCodes: List<String?> = emptyList(),
    val ox: Double = 0.0,
    val oy: Double = 0.0,
) {
    fun placed(): LiveBus = if (at != null) copy(ox = -AT_STOP_SIDE_DP, oy = AT_STOP_STEP_DP * slot) else copy(ox = 0.0, oy = 0.0)

    companion object {
        const val AT_STOP_SIDE_DP = 22.0
        const val AT_STOP_STEP_DP = 26.0
    }
}

data class BusStrip(
    val passed: String?,
    val here: String?,
    val next: String?,
    val after: List<String>,
    val more: Int,
    val passedCode: String? = null,
    val hereCode: String? = null,
    val nextCode: String? = null,
    val afterCodes: List<String?> = emptyList(),
) {
    val between: Boolean
        get() = here == null

    val any: Boolean
        get() = next != null

    companion object {
        const val AFTER = 4

        fun of(bus: LiveBus, all: Boolean = false): BusStrip {
            val ahead = bus.upcoming.ifEmpty { listOfNotNull(bus.nextStop) }
            val codes = ahead.indices.map { bus.upcomingCodes.getOrNull(it) }
            val rest = ahead.drop(1)
            val shown = if (all) rest.size else minOf(rest.size, AFTER)
            return BusStrip(
                passed = if (bus.at == null) bus.stretch?.last else null,
                here = bus.at,
                next = ahead.firstOrNull(),
                after = rest.take(shown),
                more = rest.size - shown,
                passedCode = if (bus.at == null) bus.passedCode else null,
                hereCode = bus.atCode,
                nextCode = codes.firstOrNull(),
                afterCodes = codes.drop(1).take(shown),
            )
        }
    }
}

data class Stretch(val from: Double, val to: Double, val last: String)

data class BusList(val svc: String, val available: Boolean, val buses: List<LiveBus>, val stale: Boolean = false) {
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
                        along = b.number("along"),
                        plate = b.optString("plate").takeIf { !b.isNull("plate") && it.isNotEmpty() },
                        at = b.optJSONObject("at")?.optString("name")?.ifEmpty { null },
                        slot = b.optInt("slot", 0),
                        stretch =
                            b.optJSONObject("stretch")?.let { st ->
                                val from = st.number("from")
                                val to = st.number("to")
                                val last = st.optJSONObject("last")?.optString("name")?.ifEmpty { null }
                                if (from != null && to != null && last != null) Stretch(from, to, last) else null
                            },
                        upcoming =
                            b.optJSONArray("upcoming")
                                ?.let { u ->
                                    (0 until u.length()).mapNotNull { j -> u.optJSONObject(j)?.optString("name")?.ifEmpty { null } }
                                }
                                .orEmpty(),
                        towards = b.optJSONObject("towards")?.optString("name")?.ifEmpty { null },
                        atCode = b.optJSONObject("at")?.optString("code")?.ifEmpty { null },
                        passedCode = b.optJSONObject("stretch")?.optJSONObject("last")?.optString("code")?.ifEmpty { null },
                        upcomingCodes =
                            b.optJSONArray("upcoming")
                                ?.let { u ->
                                    (0 until u.length())
                                        .mapNotNull { j -> u.optJSONObject(j)?.takeIf { it.optString("name").isNotEmpty() } }
                                        .map { it.optString("code").ifEmpty { null } }
                                }
                                .orEmpty(),
                    )
                },
                stale = o.optBoolean("stale", false),
            )
        }
    }
}

object MapGeoJson {
    fun routes(campus: CampusMap): String =
        collection(
            campus.routes.values.map { r ->
                feature(
                    JSONObject().put("type", "LineString").put("coordinates", JSONArray(r.line.map { JSONArray().put(it[0]).put(it[1]) })),
                    JSONObject().put("svc", r.svc).put("color", hex(r.color)),
                )
            }
        )

    fun stops(campus: CampusMap): String =
        collection(
            campus.stops.map { s ->
                point(
                    s.lon,
                    s.lat,
                    JSONObject().put("code", s.code).put("name", s.name).put("services", " ${s.services.joinToString(" ")} "),
                )
            }
        )

    fun buses(svc: String, color: Long, buses: List<LiveBus>): String =
        collection(
            buses.map { b ->
                point(
                    b.lon,
                    b.lat,
                    JSONObject()
                        .put("id", b.id)
                        .put("svc", svc)
                        .put("color", hex(color))
                        .put("heading", b.heading ?: 0.0)
                        .put("offset", JSONArray().put(b.ox).put(b.oy)),
                )
            }
        )

    fun stretch(color: Long, path: RoutePath?, stretch: Stretch?): String {
        val line = stretch?.let { path?.slice(it.from, it.to) } ?: return EMPTY
        return collection(
            listOf(
                feature(
                    JSONObject().put("type", "LineString").put("coordinates", JSONArray(line.map { JSONArray().put(it[0]).put(it[1]) })),
                    JSONObject().put("color", hex(color)),
                )
            )
        )
    }

    fun me(lat: Double, lon: Double): String = collection(listOf(point(lon, lat, JSONObject())))

    val EMPTY: String = collection(emptyList())

    private fun hex(argb: Long) = "#%06x".format(argb and 0xFFFFFF)

    private fun point(lon: Double, lat: Double, props: JSONObject) =
        feature(JSONObject().put("type", "Point").put("coordinates", JSONArray().put(lon).put(lat)), props)

    private fun feature(geometry: JSONObject, props: JSONObject) =
        JSONObject().put("type", "Feature").put("geometry", geometry).put("properties", props)

    private fun collection(features: List<JSONObject>) =
        JSONObject().put("type", "FeatureCollection").put("features", JSONArray(features)).toString()
}

class Slides(private val msFor: (Double) -> Long = { slideMs(it) }) {
    private class Slide(val from: LiveBus?, val to: LiveBus, val start: Long, val path: RoutePath?, val d: Double, val ms: Long = 0)

    private var slides: Map<String, Slide> = emptyMap()

    private var lastUpdate: Long? = null

    fun update(buses: List<LiveBus>, path: RoutePath?, now: Long, still: Boolean = false) {
        val stale = lastUpdate.let { it == null || now - it > STALE_MS }
        lastUpdate = now
        slides = buses.associate { raw ->
            val b = raw.placed()
            val from = slides[b.id]?.let { at(it, now) }
            val d = if (stale || still || from == null || path == null) null else path.aheadBy(from, b)
            b.id to if (d != null) Slide(from, b, now, path, d, msFor(d)) else Slide(null, b, now, null, 0.0)
        }
    }

    fun at(now: Long): List<LiveBus> = slides.values.map { at(it, now) }

    fun moving(now: Long): Boolean = slides.values.any { it.from != null && now - it.start < it.ms }

    private fun at(s: Slide, now: Long): LiveBus {
        val f = s.from
        val path = s.path
        val b = s.to
        val fa = f?.along
        val ba = b.along
        if (f == null || path == null || fa == null || ba == null) return b
        val k = ((now - s.start).toDouble() / s.ms).coerceIn(0.0, 1.0)
        if (k >= 1.0) return b
        val e = if (k < 0.5) 2 * k * k else 1 - (-2 * k + 2).pow(2) / 2
        val (lat, lon, road) = path.pointAt(fa + s.d * e)
        val (aLat, aLon) = path.pointAt(fa)
        val (bLat, bLon) = path.pointAt(ba)
        return b.copy(
            lat = lat + (f.lat - aLat) * (1 - e) + (b.lat - bLat) * e,
            lon = lon + (f.lon - aLon) * (1 - e) + (b.lon - bLon) * e,
            along = path.wrap(fa + s.d * e),
            heading = road,
            ox = f.ox + (b.ox - f.ox) * e,
            oy = f.oy + (b.oy - f.oy) * e,
        )
    }

    companion object {
        fun slideMs(m: Double): Long = (m / 100 * 1_000).toLong().coerceIn(1_000L, 4_000L)

        const val STALE_MS = 15_000L
    }
}

private fun JSONObject.number(key: String): Double? = if (!has(key) || isNull(key)) null else optDouble(key)

internal fun JSONArray?.stringList(): List<String> = if (this == null) emptyList() else (0 until length()).map { getString(it) }
