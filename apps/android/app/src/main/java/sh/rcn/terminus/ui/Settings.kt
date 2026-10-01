package sh.rcn.terminus.ui

import android.content.Intent
import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.Image
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.painter.BitmapPainter
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.graphics.createBitmap
import androidx.core.graphics.set
import androidx.core.net.toUri
import com.google.zxing.BarcodeFormat
import com.google.zxing.EncodeHintType
import com.google.zxing.qrcode.QRCodeWriter
import sh.rcn.terminus.BuildConfig
import sh.rcn.terminus.Campus
import sh.rcn.terminus.Destination
import sh.rcn.terminus.Device
import sh.rcn.terminus.ProfileDoc
import sh.rcn.terminus.SavedPlace
import sh.rcn.terminus.Trip
import sh.rcn.terminus.UsualTime
import sh.rcn.terminus.WEEKDAYS
import sh.rcn.terminus.dayName
import sh.rcn.terminus.hhmm
import sh.rcn.terminus.hhmm12
import sh.rcn.terminus.hour12

/**
 * Everything the account page has, so the website is optional for daily
 * use: account and devices, timetable, your day, getting around, places.
 */
@Composable
internal fun SettingsScreen(
    state: AccountState,
    account: AccountViewModel,
    main: MainViewModel,
    onAddEmail: () -> Unit,
    onSignedOut: () -> Unit,
    onClose: () -> Unit,
) {
    BackHandler(onBack = onClose)
    LaunchedEffect(Unit) { account.refresh() }
    LaunchedEffect(state.email) { if (state.email != null) account.loadDevices() }
    LaunchedEffect(Unit) { account.loadChoices() }

    Column(Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 12.dp), verticalAlignment = Alignment.CenterVertically) {
            Text("Settings", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = onClose) { Text("Done") }
        }
        state.message?.let {
            Card(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, modifier = Modifier.weight(1f))
                    TextButton(onClick = account::clearMessage) { Text("OK") }
                }
            }
        }
        val profile = state.profile
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            AccountSection(state, account, main, onAddEmail, onSignedOut)
            if (profile == null) {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            } else {
                Heading("Timetable")
                var link by rememberSaveable(state.sharedLink) { mutableStateOf(state.sharedLink ?: profile.share.orEmpty()) }
                TimetableImport(state, account, link) { link = it }
                Classes(profile, state.campus, account)

                Heading("Your day")
                state.campus?.let { HomePicker(profile, it, account) }
                DayHours(profile, account)

                Heading("Getting around")
                PacePicker(profile, account)
                TripChoices(state, account)
                TripHistory(state, account)

                Heading("Favourites")
                Favourites(profile, state.campus, account)
            }
            Spacer(Modifier.height(32.dp))
        }
    }
}

/** A day and a time for a favourite: from then on it's a trip that day, like a class. */
@Composable
private fun UsualTimeEditor(place: SavedPlace, account: AccountViewModel, done: () -> Unit) {
    var day by rememberSaveable { mutableIntStateOf(1) }
    var at by rememberSaveable { mutableStateOf<Int?>(null) }
    Card(Modifier.fillMaxWidth().padding(vertical = 8.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Day", WEEKDAYS, day, { day = it ?: 1 })
            TimeButton("Be there at", at, { at = it })
            Row {
                TextButton(onClick = done) { Text("Cancel") }
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = {
                        val m = at ?: return@Button
                        account.edit { it.addUsual(UsualTime(place.key, day, m)) }
                        done()
                    },
                    enabled = at != null,
                ) { Text("Add") }
            }
        }
    }
}

/** What you chose for particular classes, each undoable. */
@Composable
private fun TripChoices(state: AccountState, account: AccountViewModel) {
    if (state.choices.isEmpty()) return
    Text("Your classes", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
    state.choices.forEach { c ->
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(c.label ?: "A class no longer in your timetable")
                Text(
                    if (c.pref == "earlier") "One bus earlier" else "No reminders",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = { account.undoChoice(c) }) { Text("Undo") }
        }
    }
}

/** How each trip went, kept 35 days for the suggestions; cleared here without touching the rest. */
@Composable
private fun TripHistory(state: AccountState, account: AccountViewModel) {
    if (state.history == 0) return
    var confirm by remember { mutableStateOf(false) }
    Text("Trip history", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
    Hint(
        "terminus remembers how ${if (state.history == 1) "1 trip" else "${state.history} trips"} went, for 35 days, " +
            "only to notice a class you keep missing or skipping.",
    )
    OutlinedButton(onClick = { confirm = true }, modifier = Modifier.padding(top = 4.dp)) { Text("Clear trip history") }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text("Clear trip history?") },
            text = { Text("terminus forgets how your trips went. Choices you've made for your classes stay.") },
            confirmButton = { TextButton(onClick = { confirm = false; account.clearHistory() }) { Text("Clear") } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun AccountSection(state: AccountState, account: AccountViewModel, main: MainViewModel, onAddEmail: () -> Unit, onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    var confirm by remember { mutableStateOf<String?>(null) }
    Heading("Account")
    if (state.email == null) {
        Text("Not signed in")
        Hint("Your setup is kept on this phone's account only. Add an email to keep it if you lose the phone, and to use terminus on your Mac or the web.")
        Button(onClick = onAddEmail, modifier = Modifier.padding(top = 8.dp)) { Text("Add your email") }
        TextButton(onClick = { confirm = "delete" }) { Text("Delete this account") }
    } else {
        Text("Signed in as ${state.email}")
        Devices(state, account, onSignedOut)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            TextButton(onClick = { confirm = "signout" }) { Text("Sign out of this phone") }
            TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/account".toUri())) }) { Text("Account page") }
        }
        Hint("API keys, signing out everywhere and deleting your account are on the account page.")
    }
    when (confirm) {
        "delete" -> AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Delete this account?") },
            text = { Text("Your timetable and settings are deleted now, and the app starts over. There's no email to get them back with.") },
            confirmButton = { TextButton(onClick = { confirm = null; account.deleteAccount { main.signedOut(); onSignedOut() } }) { Text("Delete") } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
        "signout" -> AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text("Sign out of this phone?") },
            text = { Text("The app and widget stop showing your timetable. Your account and setup stay; sign in again with ${state.email}.") },
            confirmButton = { TextButton(onClick = { confirm = null; main.unpair(); account.reset(); onSignedOut() }) { Text("Sign out") } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text("Cancel") } },
        )
    }
}

@Composable
private fun Devices(state: AccountState, account: AccountViewModel, onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    var removing by remember { mutableStateOf<Device?>(null) }
    Heading("Devices")
    val devices = state.devices
    if (devices == null) {
        CircularProgressIndicator(Modifier.size(20.dp))
    } else {
        for (d in devices) {
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.name + if (d.current) " (this phone)" else "")
                    val now = System.currentTimeMillis()
                    val used = if (now - d.lastSeenMs < 60_000) "just now" else android.text.format.DateUtils.getRelativeTimeSpanString(d.lastSeenMs, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)
                    Hint(listOfNotNull(platformName(d.platform), "used $used").joinToString(" · "))
                }
                TextButton(onClick = { removing = d }) { Text("Remove") }
            }
            HorizontalDivider()
        }
    }
    OutlinedButton(onClick = account::newPairCode, modifier = Modifier.padding(top = 8.dp)) { Text("Add a device") }
    Hint("Your Mac, or another phone. Every device added or removed is emailed to you.")

    removing?.let { d ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text("Remove ${d.name}?") },
            text = { Text(if (d.current) "This phone is signed out." else "It's signed out, and you'll get an email saying so.") },
            confirmButton = { TextButton(onClick = { removing = null; account.removeDevice(d) { onSignedOut() } }) { Text("Remove") } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text("Cancel") } },
        )
    }
    state.pairCode?.let { code -> PairCodeDialog(code, account::closePairCode) }
}

private fun platformName(p: String?) = when (p) {
    "android" -> "Android"
    "mac" -> "Mac"
    "ios" -> "iPhone"
    else -> null
}

/** The code to type on a Mac, and a QR code another phone's camera opens. */
@Composable
private fun PairCodeDialog(code: String, onClose: () -> Unit) {
    val ctx = LocalContext.current
    val link = "${BuildConfig.SITE}/pair?code=$code"
    val qr = remember(link) { qrBitmap(link, 480) }
    AlertDialog(
        onDismissRequest = onClose,
        title = { Text("Add a device") },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text("On your Mac, open terminus and enter:")
                Text(
                    "${code.take(3)} ${code.drop(3)}",
                    style = MaterialTheme.typography.headlineLarge.copy(fontWeight = FontWeight.Bold, letterSpacing = 4.sp),
                    modifier = Modifier.padding(vertical = 12.dp),
                )
                Text("Or scan this with another phone's camera:")
                Image(BitmapPainter(qr.asImageBitmap()), contentDescription = "QR code for pairing code $code", modifier = Modifier.size(200.dp).padding(8.dp))
                Hint("Works once, for 10 minutes.")
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text("Done") } },
        dismissButton = {
            TextButton(onClick = {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, "Pair terminus with this link, or enter code $code: $link")
                ctx.startActivity(Intent.createChooser(send, "Send the pairing code"))
            }) { Text("Send") }
        },
    )
}

/** Black on white with a quiet zone, whatever the theme: cameras read it best. */
private fun qrBitmap(text: String, size: Int): Bitmap {
    val m = QRCodeWriter().encode(text, BarcodeFormat.QR_CODE, size, size, mapOf(EncodeHintType.MARGIN to 2))
    val bmp = createBitmap(m.width, m.height)
    for (x in 0 until m.width) for (y in 0 until m.height) bmp[x, y] = if (m[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE
    return bmp
}

/** Every class, imported or added by hand, by day and time, each with Remove; then adding one by hand. */
@Composable
private fun Classes(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    val ctx = LocalContext.current
    val h12 = hour12(ctx)
    val time = { m: Int -> if (h12) hhmm12(m) else hhmm(m) }
    val destinations = campus?.destinations.orEmpty()
    // Monday first, as the week reads; the index is the class's place in its own list.
    val order = WEEKDAYS.map { it.first }
    val all = (profile.trips.mapIndexed { i, t -> Triple(true, i, t) } + profile.manual.mapIndexed { i, t -> Triple(false, i, t) })
        .sortedWith(compareBy({ order.indexOf(it.third.day) }, { it.third.arriveByMin }))
    if (all.isNotEmpty()) {
        Text(if (all.size == 1) "1 class" else "${all.size} classes", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp))
        for ((imported, i, t) in all) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${dayName(t.day).take(3)} ${time(t.arriveByMin)} · ${t.label}")
                    val about = listOfNotNull(campus?.let { "${it.stopName(t.to)} stop" }, if (imported) null else "added by hand")
                    if (about.isNotEmpty()) Hint(about.joinToString(" · "))
                }
                TextButton(onClick = { account.edit { it.removeClass(imported, i) } }) { Text("Remove") }
            }
        }
    }
    var open by rememberSaveable { mutableStateOf(false) }
    if (!open) {
        TextButton(onClick = { open = true; account.loadCampus() }) { Text("Add a class or commitment by hand") }
        return
    }
    var day by rememberSaveable { mutableIntStateOf(1) }
    var start by rememberSaveable { mutableStateOf<Int?>(null) }
    var end by rememberSaveable { mutableStateOf<Int?>(null) }
    var label by rememberSaveable { mutableStateOf("") }
    var where by remember { mutableStateOf<Destination?>(null) }
    Card(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice("Day", WEEKDAYS, day, { day = it ?: 1 })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TimeButton("Starts", start, { start = it }, Modifier.weight(1f))
                TimeButton("Ends", end, { end = it }, Modifier.weight(1f))
            }
            OutlinedTextField(label, { if (it.length <= 60) label = it }, label = { Text("Name, e.g. Gym") }, singleLine = true, modifier = Modifier.fillMaxWidth())
            WherePicker("Where", destinations, where) { where = it }
            Row {
                TextButton(onClick = { open = false }) { Text("Cancel") }
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = {
                        val s = start ?: return@Button
                        val w = where ?: return@Button
                        account.edit { it.addManual(Trip(day, s, end?.takeIf { e -> e > s }, w.stopCode, label.trim(), "")) }
                        open = false
                        start = null; end = null; label = ""; where = null
                    },
                    enabled = start != null && where != null && label.isNotBlank(),
                ) { Text("Add") }
            }
        }
    }
}

@Composable
private fun DayHours(profile: ProfileDoc, account: AccountViewModel) {
    Spacer(Modifier.height(12.dp))
    Text("Show buses between")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        TimeButton("", profile.dayStartMin, { m -> if (m < profile.dayEndMin) account.edit { it.dayStartMin = m } }, Modifier.weight(1f))
        Text("and")
        TimeButton("", profile.dayEndMin, { m -> if (m > profile.dayStartMin) account.edit { it.dayEndMin = m } }, Modifier.weight(1f))
    }
    Hint("Outside your day, the widget shows your next class instead of a bus. A class that starts early or runs late stretches the day to fit.")
    Spacer(Modifier.height(12.dp))
    Text("Go home in gaps longer than")
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { account.edit { it.gapHours = profile.gapHours - 0.5 } }, enabled = profile.gapHours > 0.5) { Text("−") }
        val h = profile.gapHours
        Text("${if (h % 1.0 == 0.0) h.toInt().toString() else h.toString()} hours", modifier = Modifier.padding(horizontal = 16.dp))
        OutlinedButton(onClick = { account.edit { it.gapHours = profile.gapHours + 0.5 } }, enabled = profile.gapHours < 12) { Text("+") }
    }
}

@Composable
private fun Favourites(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    Hint("One tap away in the app, on the widget and in the Mac's menu bar. Give one a usual time (gym on Tuesdays at 6 pm) and it's planned like a class that day.")
    val ctx = LocalContext.current
    val time = { m: Int -> if (hour12(ctx)) hhmm12(m) else hhmm(m) }
    // A stop's name, or a food court's (favourites and classes can go to one).
    val stopName = { code: String ->
        campus?.stops?.firstOrNull { it.code == code }?.name ?: campus?.destinations?.firstOrNull { it.code == code && it.kind == "landmark" }?.label ?: code
    }
    var timing by rememberSaveable { mutableStateOf<String?>(null) }
    var note by remember { mutableStateOf<String?>(null) }
    for (p in profile.places) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(p.label)
                // Where it goes, when the name doesn't already say (a building's stop, or a name from before favourites).
                if (campus != null && p.label != stopName(p.to)) Hint("${stopName(p.to)} stop")
            }
            TextButton(onClick = { timing = if (timing == p.key) null else p.key }) { Text("Usual time") }
            TextButton(onClick = { account.edit { it.removePlace(p.key) } }) { Text("Remove") }
        }
        for (u in profile.usual.filter { it.place == p.key }) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("${dayName(u.day).take(3)} ${time(u.atMin)}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = { account.edit { it.removeUsual(u) } }) { Text("Remove") }
            }
        }
        if (timing == p.key) UsualTimeEditor(p, account) { timing = null }
    }
    if (profile.places.size >= 12) return
    // The stops your classes go to come first, each saying which classes use it.
    val favourite = profile.places.map { it.to }.toSet()
    val timetable = (profile.trips + profile.manual).groupBy { it.to }
        .filterKeys { it !in favourite }
        .map { (to, classes) -> Destination(to, stopName(to), to, "timetable", detail = classes.map { it.label.substringBefore(" @ ") }.distinct().joinToString(", ")) }
        .sortedBy { it.label }
    Spacer(Modifier.height(8.dp))
    WherePicker("Add a favourite", campus?.destinations.orEmpty(), null, timetable) { d ->
        if (d == null) return@WherePicker
        // No name to type: it's called what was picked, short, as it reads on a button.
        val to = if (d.kind == "landmark") d.code else d.stopCode
        val same = profile.places.firstOrNull { it.to == to }
        if (same != null) {
            note = "Already a favourite: ${same.label}"
        } else {
            note = null
            account.edit { it.addPlace(if (d.kind == "building" || d.kind == "room") d.code else d.label, to) }
        }
    }
    note?.let { Hint(it) }
    LaunchedEffect(Unit) { account.loadCampus() }
}
