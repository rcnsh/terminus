package sh.rcn.terminus

import kotlinx.coroutines.runBlocking
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Versioned profile saves: If-Match, and on a clash (412) only this phone's changes made again on the server's profile. */
class ProfileSaveTest {
    init {
        TestStrings.install()
    }

    /** The server's profile and its version, refusing a save from an older one as /api/me/profile does. */
    private class Server(json: String, var version: Int = 1) {
        var profile = JSONObject(json)
        val saves = mutableListOf<String?>()
        var loads = 0

        fun load(): Tagged {
            loads++
            return Tagged(JSONObject(profile.toString()), "\"$version\"")
        }

        fun save(json: JSONObject, ifMatch: String?): Tagged {
            saves += ifMatch
            if (ifMatch != null && ifMatch != "\"$version\"") throw ApiError(412, "the profile was changed elsewhere")
            profile = JSONObject(json.toString())
            version++
            return Tagged(JSONObject(profile.toString()), "\"$version\"")
        }

        /** Another device saving meanwhile. */
        fun elsewhere(change: (JSONObject) -> Unit) {
            change(profile)
            version++
        }
    }

    private fun save(server: Server, base: ProfileDoc, version: String?, changes: List<ProfileChange>, tries: Int = 3) = runBlocking {
        saveChanges(base, version, changes, load = { server.load() }, save = { json, tag -> server.save(json, tag) }, tries = tries)
    }

    @Test
    fun `a save sends the version it was made from`() {
        val server = Server("""{"walkPace":"normal","pinnedStops":[]}""")
        val base = ProfileDoc(server.load().json)
        val r = save(server, base, "\"1\"", listOf { it.walkPace = "fast" })
        assertEquals(listOf<String?>("\"1\""), server.saves)
        assertEquals("fast", r.doc.walkPace)
        assertEquals("\"2\"", r.version)
        assertFalse(r.missed)
    }

    @Test
    fun `saved elsewhere meanwhile, only this phone's changes go on top of it`() {
        val server = Server("""{"walkPace":"normal","pinnedStops":["COM3"],"places":[]}""")
        val base = ProfileDoc(server.load().json)
        // A pin from the Buses tab on another device, after this phone loaded the profile.
        server.elsewhere { it.put("pinnedStops", org.json.JSONArray(listOf("COM3", "PGP"))) }
        val r = save(server, base, "\"1\"", listOf({ it.walkPace = "fast" }, { it.addPlace("Gym", "UTOWN") }))
        assertEquals(listOf<String?>("\"1\"", "\"2\""), server.saves)
        assertEquals(listOf("COM3", "PGP"), r.doc.pinnedStops)
        assertEquals("fast", r.doc.walkPace)
        assertEquals(listOf("gym"), r.doc.places.map { it.key })
        assertEquals("\"3\"", r.version)
    }

    @Test
    fun `a pin and a favourite made again on a newer profile aren't undone or doubled`() {
        val server = Server("""{"pinnedStops":["PGP"],"places":[]}""")
        val base = ProfileDoc(server.load().json)
        // Another device pins COM3 and adds the same favourite first.
        server.elsewhere {
            it.put("pinnedStops", org.json.JSONArray(listOf("PGP", "COM3")))
            it.put("places", org.json.JSONArray().put(JSONObject().put("key", "gym").put("label", "Gym").put("to", "UTOWN")))
        }
        val on = "COM3" !in base.pinnedStops
        val r =
            save(
                server,
                base,
                "\"1\"",
                listOf({ it.pinnedStops = Pins.set(it.pinnedStops, "COM3", on, it.limits.pinnedStops) }, { it.addPlace("Gym", "UTOWN") }),
            )
        assertEquals(listOf("PGP", "COM3"), r.doc.pinnedStops)
        assertEquals(listOf("gym"), r.doc.places.map { it.key })
    }

    @Test
    fun `a favourite removed is the one at its stop, whatever key it was given`() {
        val server = Server("""{"places":[]}""")
        val base = ProfileDoc(server.load().json)
        // Another device saves a different stop under the key this phone's add would take.
        server.elsewhere {
            it.put("places", org.json.JSONArray().put(JSONObject().put("key", "com3").put("label", "COM3").put("to", "KR-MRT")))
        }
        val r = save(server, base, "\"1\"", listOf({ it.addPlace("COM3", "COM3") }, { it.removePlaceAt("COM3") }))
        assertEquals(listOf("KR-MRT"), r.doc.places.map { it.to })
    }

    @Test
    fun `with no version to go by, the server's profile is read first`() {
        val server = Server("""{"walkPace":"normal","pinnedStops":["KR-MRT"]}""")
        val r = save(server, ProfileDoc(JSONObject("""{"walkPace":"normal"}""")), null, listOf { it.walkPace = "slow" })
        assertEquals(1, server.loads)
        assertEquals(listOf<String?>("\"1\""), server.saves)
        assertEquals(listOf("KR-MRT"), r.doc.pinnedStops)
        assertEquals("slow", r.doc.walkPace)
    }

    @Test
    fun `a clash every time gives up after the tries, saying so`() {
        val server = Server("""{"walkPace":"normal"}""")
        val base = ProfileDoc(server.load().json)
        val racing =
            object : (ProfileDoc) -> Unit {
                override fun invoke(p: ProfileDoc) {
                    p.walkPace = "fast"
                    // Someone else saves between each read and each save.
                    server.elsewhere {}
                }
            }
        val e = runCatching { save(server, base, "\"1\"", listOf(racing)) }.exceptionOrNull()
        assertEquals(412, (e as ApiError).status)
        assertEquals(3, server.saves.size)
    }

    @Test
    fun `another refusal is not retried`() {
        val base = ProfileDoc(JSONObject("{}"))
        var saves = 0
        val e = runCatching {
            runBlocking {
                saveChanges(
                    base,
                    "\"1\"",
                    listOf { it.walkPace = "fast" },
                    load = { error("not read") },
                    save = { _, _ ->
                        saves++
                        throw ApiError(400, "bad")
                    },
                )
            }
        }
            .exceptionOrNull()
        assertEquals(400, (e as ApiError).status)
        assertEquals(1, saves)
    }

    @Test
    fun `a class changed again is found where it moved, not its neighbour`() {
        val trips =
            """[{"day":1,"arriveByMin":600,"to":"COM3","label":"CS2030","venue":"COM1-0204"},{"day":3,"arriveByMin":540,"to":"UTOWN","label":"GEA1000","venue":"UT-AUD1"}]"""
        val server = Server("""{"trips":$trips}""")
        val base = ProfileDoc(server.load().json)
        val gea = base.classAt(imported = true, 1)!!
        // Another device removes the first class: GEA1000 is now at index 0.
        server.elsewhere { it.getJSONArray("trips").remove(0) }
        val r = save(server, base, "\"1\"", listOf { it.setClassStop(imported = true, 1, gea, "KR-MRT") })
        assertEquals(listOf("GEA1000"), r.doc.trips.map { it.label })
        assertEquals("KR-MRT", r.doc.trips.single().to)
        assertFalse(r.missed)
    }

    @Test
    fun `a class removed elsewhere is missed, and nothing else changes`() {
        val trips =
            """[{"day":1,"arriveByMin":600,"to":"COM3","label":"CS2030","venue":"COM1-0204"},{"day":3,"arriveByMin":540,"to":"UTOWN","label":"GEA1000","venue":"UT-AUD1"}]"""
        val server = Server("""{"trips":$trips}""")
        val base = ProfileDoc(server.load().json)
        val cs = base.classAt(imported = true, 0)!!
        server.elsewhere { it.getJSONArray("trips").remove(0) }
        val r = save(server, base, "\"1\"", listOf { it.removeClass(imported = true, 0, cs) })
        assertEquals(listOf("GEA1000"), r.doc.trips.map { it.label })
        assertTrue(r.missed)
    }

    @Test
    fun `an imported class is told from another row of it by its weeks`() {
        // One module's two rows, the same but for their weeks: the one removed elsewhere isn't found in the other.
        val trips =
            """[{"day":1,"arriveByMin":600,"to":"COM3","label":"CS2030","venue":"COM1-0204","weeks":[1,3,5]},{"day":1,"arriveByMin":600,"to":"COM3","label":"CS2030","venue":"COM1-0204","weeks":[2,4,6]}]"""
        val server = Server("""{"trips":$trips}""")
        val base = ProfileDoc(server.load().json)
        val odd = base.classAt(imported = true, 0)!!
        server.elsewhere { it.getJSONArray("trips").remove(0) }
        val r = save(server, base, "\"1\"", listOf { it.setClassStop(imported = true, 0, odd, "KR-MRT") })
        assertEquals("COM3", r.doc.trips.single().to)
        assertTrue(r.missed)
    }

    @Test
    fun `undo puts a favourite back under a free key when its own was taken meanwhile`() {
        val p =
            ProfileDoc(
                JSONObject("""{"places":[{"key":"com3","label":"COM3","to":"COM3"}],"usual":[{"place":"com3","day":1,"atMin":600}]}""")
            )
        val removed = p.removePlaceAt("COM3")!!
        p.addPlace("COM3", "KR-MRT")
        p.restorePlace(removed)
        assertEquals(listOf("COM3" to "com3-2", "KR-MRT" to "com3"), p.places.map { it.to to it.key }.sortedBy { it.first })
        assertEquals(listOf("com3-2"), p.usual.map { it.place })
    }

    @Test
    fun `an edit to a class the base no longer has is said too`() {
        // Made during an import whose timetable doesn't have it: saved first time, still missed.
        val server = Server("""{"trips":[]}""")
        val gone = JSONObject("""{"day":1,"arriveByMin":600,"to":"COM3","label":"CS2030","venue":""}""")
        val r = save(server, ProfileDoc(server.load().json), "\"1\"", listOf { it.removeClass(imported = true, 0, gone) })
        assertTrue(r.missed)
    }

    @Test
    fun `a second tap on a class already removed takes nothing else`() {
        val p =
            ProfileDoc(
                JSONObject(
                    """{"manual":[{"day":1,"arriveByMin":600,"to":"COM3","label":"Gym","venue":""},{"day":2,"arriveByMin":600,"to":"COM3","label":"Choir","venue":""}]}"""
                )
            )
        val gym = p.classAt(imported = false, 0)!!
        p.removeClass(imported = false, 0, gym)
        p.removeClass(imported = false, 0, gym)
        assertEquals(listOf("Choir"), p.manual.map { it.label })
        assertTrue(p.missed)
        assertNull(p.manual.firstOrNull { it.label == "Gym" })
    }
}
