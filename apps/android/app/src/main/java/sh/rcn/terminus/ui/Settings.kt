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
import sh.rcn.terminus.dayShort
import sh.rcn.terminus.hhmm
import sh.rcn.terminus.hhmm12
import sh.rcn.terminus.hour12
import androidx.compose.ui.res.stringResource
import sh.rcn.terminus.R
import sh.rcn.terminus.Lang
import sh.rcn.terminus.L

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
            Text(stringResource(R.string.settings), style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = onClose) { Text(stringResource(R.string.done)) }
        }
        state.message?.let {
            Card(Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                Row(Modifier.padding(horizontal = 12.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text(it, modifier = Modifier.weight(1f))
                    TextButton(onClick = account::clearMessage) { Text(stringResource(R.string.ok)) }
                }
            }
        }
        val profile = state.profile
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            AccountSection(state, account, main, onAddEmail, onSignedOut)
            LanguagePicker(account)
            if (profile == null) {
                Box(Modifier.fillMaxWidth().padding(32.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            } else {
                Heading(stringResource(R.string.heading_timetable))
                var link by rememberSaveable(state.sharedLink) { mutableStateOf(state.sharedLink ?: profile.share.orEmpty()) }
                TimetableImport(state, account, link) { link = it }
                Classes(profile, state.campus, account)

                Heading(stringResource(R.string.heading_your_day))
                state.campus?.let { HomePicker(profile, it, account) }
                DayHours(profile, account)

                Heading(stringResource(R.string.heading_getting_around))
                PacePicker(profile, account)
                TripChoices(state, account)
                TripHistory(state, account)

                Heading(stringResource(R.string.heading_favourites))
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
            Choice(stringResource(R.string.day), WEEKDAYS, day, { day = it ?: 1 })
            TimeButton(stringResource(R.string.be_there_at), at, { at = it })
            Row {
                TextButton(onClick = done) { Text(stringResource(R.string.cancel)) }
                Spacer(Modifier.weight(1f))
                Button(
                    onClick = {
                        val m = at ?: return@Button
                        account.edit { it.addUsual(UsualTime(place.key, day, m)) }
                        done()
                    },
                    enabled = at != null,
                ) { Text(stringResource(R.string.add)) }
            }
        }
    }
}

/** What you chose for particular classes, each undoable. */
@Composable
private fun TripChoices(state: AccountState, account: AccountViewModel) {
    if (state.choices.isEmpty()) return
    Text(stringResource(R.string.your_classes), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
    state.choices.forEach { c ->
        Row(Modifier.fillMaxWidth().padding(vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text(c.label ?: stringResource(R.string.class_gone))
                Text(
                    if (c.pref == "earlier") stringResource(R.string.one_bus_earlier) else stringResource(R.string.no_reminders),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            TextButton(onClick = { account.undoChoice(c) }) { Text(stringResource(R.string.undo)) }
        }
    }
}

/** How each trip went, kept 35 days for the suggestions; cleared here without touching the rest. */
@Composable
private fun TripHistory(state: AccountState, account: AccountViewModel) {
    if (state.history == 0) return
    var confirm by remember { mutableStateOf(false) }
    Text(stringResource(R.string.trip_history), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 16.dp))
    Hint(if (state.history == 1) stringResource(R.string.history_one) else stringResource(R.string.history_n, state.history))
    OutlinedButton(onClick = { confirm = true }, modifier = Modifier.padding(top = 4.dp)) { Text(stringResource(R.string.clear_history)) }
    if (confirm) {
        AlertDialog(
            onDismissRequest = { confirm = false },
            title = { Text(stringResource(R.string.clear_history_title)) },
            text = { Text(stringResource(R.string.clear_history_text)) },
            confirmButton = { TextButton(onClick = { confirm = false; account.clearHistory() }) { Text(stringResource(R.string.clear)) } },
            dismissButton = { TextButton(onClick = { confirm = false }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun AccountSection(state: AccountState, account: AccountViewModel, main: MainViewModel, onAddEmail: () -> Unit, onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    var confirm by remember { mutableStateOf<String?>(null) }
    Heading(stringResource(R.string.heading_account))
    if (state.email == null) {
        Text(stringResource(R.string.not_signed_in))
        Hint(stringResource(R.string.not_signed_in_hint))
        Button(onClick = onAddEmail, modifier = Modifier.padding(top = 8.dp)) { Text(stringResource(R.string.add_email)) }
        TextButton(onClick = { confirm = "delete" }) { Text(stringResource(R.string.delete_account)) }
    } else {
        Text(stringResource(R.string.signed_in_as, state.email))
        Devices(state, account, onSignedOut)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
            TextButton(onClick = { confirm = "signout" }) { Text(stringResource(R.string.sign_out_phone)) }
            TextButton(onClick = { ctx.startActivity(Intent(Intent.ACTION_VIEW, "${BuildConfig.SITE}/account".toUri())) }) { Text(stringResource(R.string.account_page)) }
        }
        Hint(stringResource(R.string.account_page_hint))
    }
    when (confirm) {
        "delete" -> AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(stringResource(R.string.delete_account_title)) },
            text = { Text(stringResource(R.string.delete_account_text)) },
            confirmButton = { TextButton(onClick = { confirm = null; account.deleteAccount { main.signedOut(); onSignedOut() } }) { Text(stringResource(R.string.delete)) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
        )
        "signout" -> AlertDialog(
            onDismissRequest = { confirm = null },
            title = { Text(stringResource(R.string.sign_out_title)) },
            text = { Text(stringResource(R.string.sign_out_text, state.email.orEmpty())) },
            confirmButton = { TextButton(onClick = { confirm = null; main.unpair(); account.reset(); onSignedOut() }) { Text(stringResource(R.string.sign_out)) } },
            dismissButton = { TextButton(onClick = { confirm = null }) { Text(stringResource(R.string.cancel)) } },
        )
    }
}

@Composable
private fun Devices(state: AccountState, account: AccountViewModel, onSignedOut: () -> Unit) {
    val ctx = LocalContext.current
    var removing by remember { mutableStateOf<Device?>(null) }
    Heading(stringResource(R.string.heading_devices))
    val devices = state.devices
    if (devices == null) {
        CircularProgressIndicator(Modifier.size(20.dp))
    } else {
        for (d in devices) {
            Row(Modifier.fillMaxWidth().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text(d.name + if (d.current) stringResource(R.string.this_phone) else "")
                    val now = System.currentTimeMillis()
                    val used = if (now - d.lastSeenMs < 60_000) stringResource(R.string.just_now) else android.text.format.DateUtils.getRelativeTimeSpanString(d.lastSeenMs, now, android.text.format.DateUtils.MINUTE_IN_MILLIS)
                    Hint(listOfNotNull(platformName(d.platform), stringResource(R.string.used_when, used)).joinToString(" · "))
                }
                TextButton(onClick = { removing = d }) { Text(stringResource(R.string.remove)) }
            }
            HorizontalDivider()
        }
    }
    OutlinedButton(onClick = account::newPairCode, modifier = Modifier.padding(top = 8.dp)) { Text(stringResource(R.string.add_device)) }
    Hint(stringResource(R.string.add_device_hint))

    removing?.let { d ->
        AlertDialog(
            onDismissRequest = { removing = null },
            title = { Text(stringResource(R.string.remove_device_title, d.name)) },
            text = { Text(if (d.current) stringResource(R.string.remove_this_phone) else stringResource(R.string.remove_other)) },
            confirmButton = { TextButton(onClick = { removing = null; account.removeDevice(d) { onSignedOut() } }) { Text(stringResource(R.string.remove)) } },
            dismissButton = { TextButton(onClick = { removing = null }) { Text(stringResource(R.string.cancel)) } },
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
        title = { Text(stringResource(R.string.add_device)) },
        text = {
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                Text(stringResource(R.string.on_mac_enter))
                Text(
                    "${code.take(3)} ${code.drop(3)}",
                    style = MaterialTheme.typography.headlineLarge.copy(fontWeight = FontWeight.Bold, letterSpacing = 4.sp),
                    modifier = Modifier.padding(vertical = 12.dp),
                )
                Text(stringResource(R.string.or_scan))
                Image(BitmapPainter(qr.asImageBitmap()), contentDescription = stringResource(R.string.qr_desc, code), modifier = Modifier.size(200.dp).padding(8.dp))
                Hint(stringResource(R.string.works_once))
            }
        },
        confirmButton = { TextButton(onClick = onClose) { Text(stringResource(R.string.done)) } },
        dismissButton = {
            TextButton(onClick = {
                val send = Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT, L.s(R.string.pair_share_text, code, link))
                ctx.startActivity(Intent.createChooser(send, L.s(R.string.send_pair_code)))
            }) { Text(stringResource(R.string.send)) }
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
        Text(if (all.size == 1) stringResource(R.string.one_class) else stringResource(R.string.n_classes, all.size), style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(top = 12.dp))
        for ((imported, i, t) in all) {
            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("${dayShort(t.day)} ${time(t.arriveByMin)} · ${t.label}")
                    val about = listOfNotNull(campus?.let { L.s(R.string.stop_suffix, it.stopName(t.to)) }, if (imported) null else stringResource(R.string.added_by_hand))
                    if (about.isNotEmpty()) Hint(about.joinToString(" · "))
                }
                TextButton(onClick = { account.edit { it.removeClass(imported, i) } }) { Text(stringResource(R.string.remove)) }
            }
        }
    }
    var open by rememberSaveable { mutableStateOf(false) }
    if (!open) {
        TextButton(onClick = { open = true; account.loadCampus() }) { Text(stringResource(R.string.add_by_hand)) }
        return
    }
    var day by rememberSaveable { mutableIntStateOf(1) }
    var start by rememberSaveable { mutableStateOf<Int?>(null) }
    var end by rememberSaveable { mutableStateOf<Int?>(null) }
    var label by rememberSaveable { mutableStateOf("") }
    var where by remember { mutableStateOf<Destination?>(null) }
    Card(Modifier.fillMaxWidth().padding(top = 8.dp)) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
            Choice(stringResource(R.string.day), WEEKDAYS, day, { day = it ?: 1 })
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TimeButton(stringResource(R.string.starts), start, { start = it }, Modifier.weight(1f))
                TimeButton(stringResource(R.string.ends), end, { end = it }, Modifier.weight(1f))
            }
            OutlinedTextField(label, { if (it.length <= 60) label = it }, label = { Text(stringResource(R.string.name_eg_gym)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            WherePicker(stringResource(R.string.where), destinations, where) { where = it }
            Row {
                TextButton(onClick = { open = false }) { Text(stringResource(R.string.cancel)) }
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
                ) { Text(stringResource(R.string.add)) }
            }
        }
    }
}

@Composable
private fun DayHours(profile: ProfileDoc, account: AccountViewModel) {
    Spacer(Modifier.height(12.dp))
    Text(stringResource(R.string.show_buses_between))
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
        TimeButton("", profile.dayStartMin, { m -> if (m < profile.dayEndMin) account.edit { it.dayStartMin = m } }, Modifier.weight(1f))
        Text(stringResource(R.string.and))
        TimeButton("", profile.dayEndMin, { m -> if (m > profile.dayStartMin) account.edit { it.dayEndMin = m } }, Modifier.weight(1f))
    }
    Hint(stringResource(R.string.day_hours_hint))
    Spacer(Modifier.height(12.dp))
    Text(stringResource(R.string.gap_home))
    Row(verticalAlignment = Alignment.CenterVertically) {
        OutlinedButton(onClick = { account.edit { it.gapHours = profile.gapHours - 0.5 } }, enabled = profile.gapHours > 0.5) { Text("−") }
        val h = profile.gapHours
        Text(stringResource(R.string.n_hours, if (h % 1.0 == 0.0) h.toInt().toString() else h.toString()), modifier = Modifier.padding(horizontal = 16.dp))
        OutlinedButton(onClick = { account.edit { it.gapHours = profile.gapHours + 0.5 } }, enabled = profile.gapHours < 12) { Text("+") }
    }
}

@Composable
private fun Favourites(profile: ProfileDoc, campus: Campus?, account: AccountViewModel) {
    Hint(stringResource(R.string.favourites_hint))
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
                if (campus != null && p.label != stopName(p.to)) Hint(stringResource(R.string.stop_suffix, stopName(p.to)))
            }
            TextButton(onClick = { timing = if (timing == p.key) null else p.key }) { Text(stringResource(R.string.usual_time)) }
            TextButton(onClick = { account.edit { it.removePlace(p.key) } }) { Text(stringResource(R.string.remove)) }
        }
        for (u in profile.usual.filter { it.place == p.key }) {
            Row(Modifier.fillMaxWidth().padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Text("${dayShort(u.day)} ${time(u.atMin)}", style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
                TextButton(onClick = { account.edit { it.removeUsual(u) } }) { Text(stringResource(R.string.remove)) }
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
    WherePicker(stringResource(R.string.add_favourite), campus?.destinations.orEmpty(), null, timetable) { d ->
        if (d == null) return@WherePicker
        // No name to type: it's called what was picked, short, as it reads on a button.
        val to = if (d.kind == "landmark") d.code else d.stopCode
        val same = profile.places.firstOrNull { it.to == to }
        if (same != null) {
            note = L.s(R.string.already_favourite, same.label)
        } else {
            note = null
            account.edit { it.addPlace(if (d.kind == "building" || d.kind == "room") d.code else d.label, to) }
        }
    }
    note?.let { Hint(it) }
    LaunchedEffect(Unit) { account.loadCampus() }
}

/** Follow the phone, English or 中文 (phase 10). The languages are named in themselves. */
@Composable
internal fun LanguagePicker(account: AccountViewModel) {
    val ctx = LocalContext.current
    Heading(stringResource(R.string.heading_language))
    Choice(
        stringResource(R.string.language),
        listOf(Lang.AUTO to stringResource(R.string.follow_device), Lang.EN to "English", Lang.ZH to "中文"),
        Lang.pref(ctx),
        { it?.let(account::setLang) },
    )
    Hint(stringResource(R.string.language_hint), Modifier.padding(top = 4.dp))
}

