package sh.rcn.terminus.ui

import android.content.Intent
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.delay
import sh.rcn.terminus.CardAction
import sh.rcn.terminus.CardStyle
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R
import sh.rcn.terminus.Ride
import sh.rcn.terminus.Suggestion
import sh.rcn.terminus.Upcoming
import sh.rcn.terminus.widget.clock
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.widget.isOld
import androidx.compose.ui.res.stringResource

@Composable
internal fun AnswerCard(
    answer: NextAnswer?,
    loading: Boolean,
    onAction: (CardAction) -> Unit = {},
    busy: Boolean = false,
    onSuggestion: (Suggestion, Boolean) -> Unit = { _, _ -> },
    onPlace: (String) -> Unit = {},
) {
    // On the page, not in a box: the answer is the screen. A minimum height
    // keeps what's under it from jumping as answers come and go.
    Column(
        Modifier.fillMaxWidth().heightIn(min = 180.dp).padding(top = 4.dp),
        verticalArrangement = Arrangement.spacedBy(4.dp),
    ) {
        if (answer == null) {
            SkyHead { Text(if (loading) stringResource(R.string.checking) else stringResource(R.string.no_answer_yet), style = MaterialTheme.typography.titleLarge) }
            SkyGround()
            return@Column
        }
        if (answer.mode == "rest" || answer.isFree || answer.arrived) {
            // Nothing to catch: said plainly, with no bus to mistake for advice.
            DayDone(answer, night = answer.mode == "rest", onPlace)
            if (answer.mode != "rest") Actions(answer, onAction, busy, onSuggestion)
            return@Column
        }
        // What comes before any answer, in the sky with its top.
        val lead: @Composable ColumnScope.() -> Unit = {
            // NUS's live times are down: said once, above the answer.
            answer.card?.notice?.let { ToneText(it, MaterialTheme.colorScheme.tertiary, MaterialTheme.typography.bodySmall) }
            // Where the trip is, when one is under way: the same on every device.
            answer.phaseText?.let { Pill(it, smallAccent()) }
            // On the bus: how far along the ride, and the next stop, as the live notification shows.
            answer.card?.ride?.let { RideProgress(it) }
            answer.card?.warning?.let { ToneText(it, MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.SemiBold) }
        }
        // Past the card's staleAt: its times may be gone, so they're dimmed
        // and "Updating times…" stands in until the refresh lands, as on the
        // web and the Mac. The styled cards fall through to the plain one.
        val old = stale(answer)
        // A trip by bus or on foot, drawn in the style chosen in Settings › Appearance.
        answer.card?.journey?.takeIf { !answer.arrived && !old }?.let { journey ->
            JourneyCard(answer, journey, CardStyle.pref(LocalContext.current), lead)
            Actions(answer, onAction, busy, onSuggestion)
            return@Column
        }
        if (answer.isClassPlan && !old) {
            SkyHead { lead(); ClassPlan(answer) }
            SkyGround()
            Actions(answer, onAction, busy, onSuggestion)
            return@Column
        }
        // The server's ("Going to KR MRT", "Long gap · Home"); worked out here only for an older server.
        val heading = answer.card?.heading ?: when {
            answer.mode == "nearby" -> stringResource(R.string.chip_nearby)
            answer.why == "gap-home" -> stringResource(R.string.long_gap, answer.destLabel.orEmpty())
            else -> answer.destLabel
        }
        SkyHead {
            lead()
            heading?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            val ctx = LocalContext.current
            val muted = MaterialTheme.colorScheme.onSurfaceVariant
            Text(
                answer.clockLabel { clock(ctx, it) },
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold,
                color = if (old) muted else MaterialTheme.colorScheme.onSurface,
            )
            if (old) {
                Text(stringResource(R.string.updating_times), color = muted)
            } else {
                Countdown(answer)
                Text(answer.detail)
                LeaveLine(answer)
            }
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(top = 4.dp)) {
                answer.timingText?.takeIf { !old }?.let { Pill(it, timingColor(answer.timingStatus)) }
                answer.crowdText?.let { Pill(it, muted) }
            }
            // The alternative is already at the end of `detail`.
            answer.qualityText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        SkyGround()
        Actions(answer, onAction, busy, onSuggestion)
    }
}

/** Whether [answer] is past its staleAt ([isOld]), checked again when that comes. */
@Composable
private fun stale(answer: NextAnswer): Boolean {
    val old by produceState(isOld(answer, ServerClock.now()), answer) {
        while (!value) {
            val at = answer.card?.staleAtMs ?: break
            // At most a minute at a time, in case the clock's correction moves.
            delay((at - ServerClock.now()).coerceIn(50, 60_000))
            value = isOld(answer, ServerClock.now())
        }
    }
    return old
}

/**
 * The server's buttons (plans only: "Not going", "Not on campus today",
 * "Back on campus"), in its order: the first one filled, the rest outlined. Then
 * anything terminus has to suggest.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun Actions(answer: NextAnswer, onAction: (CardAction) -> Unit, busy: Boolean, onSuggestion: (Suggestion, Boolean) -> Unit = { _, _ -> }) {
    // "Catch the D2 at Museum", and you don't know where Museum is: walking
    // directions there, as the one filled button; the server's go beside it.
    val walkTo = answer.card?.walkTo
    // The server's "Undo: going to UTown" isn't shown: "Not going" offers
    // Undo in the bar at the foot of the screen, as a swipe off Today does.
    val all = answer.card?.actions.orEmpty().filter { it.id != "reset" }
    // "Not going" and "Not on campus today" are the same no for this class
    // and for the whole day. With both on the card they share one menu, so
    // they don't crowd out what the card is for.
    val skips = all.filter { it.id == "skipped" || it.id == "away" }.takeIf { it.size > 1 }.orEmpty()
    val actions = all - skips.toSet()
    walkTo?.let { w ->
        val ctx = LocalContext.current
        Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, w.mapsUri())) } },
                modifier = Modifier.weight(1f).height(48.dp),
            ) { Text(stringResource(R.string.directions_to, w.name), maxLines = 1) }
            if (skips.isNotEmpty()) SkipMenu(skips, onAction, busy, label = null)
            else actions.firstOrNull()?.let { a -> OutlinedButton(onClick = { onAction(a) }, enabled = !busy, modifier = Modifier.height(48.dp)) { Text(a.label, maxLines = 1) } }
        }
    }
    val rest = if (walkTo != null && skips.isEmpty()) actions.drop(1) else actions
    // Without directions, the menu is a button named for the first choice.
    val skipButton = walkTo == null && skips.isNotEmpty()
    if (rest.isNotEmpty() || skipButton) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = if (walkTo != null) 6.dp else 10.dp)) {
            rest.forEachIndexed { i, a ->
                if (i == 0 && walkTo == null && a.id != "skipped" && a.id != "reset") {
                    Button(onClick = { onAction(a) }, enabled = !busy) { Text(a.label) }
                } else {
                    OutlinedButton(onClick = { onAction(a) }, enabled = !busy) { Text(a.label) }
                }
            }
            if (skipButton) SkipMenu(skips, onAction, busy, label = skips.first().label)
        }
    }
    answer.card?.suggestion?.let { s ->
        OutlinedCard(Modifier.padding(top = 14.dp)) {
            Column(Modifier.padding(12.dp)) {
                Text(s.text, style = MaterialTheme.typography.bodyMedium)
                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp), modifier = Modifier.padding(top = 8.dp)) {
                    Button(onClick = { onSuggestion(s, true) }, enabled = !busy) { Text(s.accept) }
                    OutlinedButton(onClick = { onSuggestion(s, false) }, enabled = !busy) { Text(s.dismiss) }
                }
            }
        }
    }
}

/**
 * The skips behind one button: ⋯ beside directions, or [label] on its own.
 * Each choice says underneath how much it skips.
 */
@Composable
private fun SkipMenu(skips: List<CardAction>, onAction: (CardAction) -> Unit, busy: Boolean, label: String?) {
    var open by remember { mutableStateOf(false) }
    Box {
        if (label == null) {
            OutlinedButton(onClick = { open = true }, enabled = !busy, modifier = Modifier.size(48.dp), contentPadding = PaddingValues(0.dp)) {
                Icon(painterResource(R.drawable.ic_more), contentDescription = stringResource(R.string.more_options), modifier = Modifier.size(20.dp))
            }
        } else {
            OutlinedButton(onClick = { open = true }, enabled = !busy) { Text(label) }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            skips.forEach { a ->
                val hint = when (a.id) {
                    "skipped" -> stringResource(R.string.skips_class)
                    "away" -> stringResource(R.string.skips_day)
                    else -> null
                }
                DropdownMenuItem(
                    text = {
                        Column(Modifier.padding(vertical = 4.dp)) {
                            Text(a.label, style = MaterialTheme.typography.bodyLarge)
                            hint?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                        }
                    },
                    onClick = { open = false; onAction(a) },
                )
            }
        }
    }
}

/**
 * A class: when to leave is the headline, the bus that goes with it and when
 * it gets you there underneath, and the next bus as the "or go now" option.
 * Every arrival sits next to the bus it belongs to.
 */
@Composable
internal fun ClassPlan(answer: NextAnswer) {
    val ctx = LocalContext.current
    val at = answer.leaveAtMs ?: return
    val fmt = { ms: Long -> clock(ctx, ms) }
    // Minute resolution is enough for "in 24 min"; seconds near the end.
    val now by produceState(ServerClock.now(), at) {
        while (true) {
            value = ServerClock.now()
            delay(if (at - value < 120_000) 1_000 else 15_000)
        }
    }
    val late = answer.leaveLate
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val starts = answer.classAtMs?.let { stringResource(R.string.starts_at, fmt(it)) }
    Text(
        listOfNotNull(answer.destLabel, starts).joinToString(" · "),
        color = muted,
    )
    Text(
        answer.leaveHeadline(now).orEmpty(),
        style = MaterialTheme.typography.headlineMedium,
        fontWeight = FontWeight.Bold,
        color = if (late) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
    )
    // Counting down to leaving; at the stop the headline is the bus and its time.
    val left = if (answer.card?.phase == "waiting") 0 else (at - now) / 1000
    if (left > 0) {
        Text(
            if (left >= 120) stringResource(R.string.in_min, ((left + 30) / 60).toInt()) else stringResource(R.string.in_min_s, (left / 60).toInt(), (left % 60).toInt()),
            style = MaterialTheme.typography.titleSmall,
            color = smallAccent(),
        )
    }
    // The bus to catch, and underneath when it gets you there. The stop is
    // named here, so no separate "board at" or general detail line below.
    // One colour for "go" (the countdown above); red only when it's late.
    val error = MaterialTheme.colorScheme.error
    answer.catchHow?.let { Text(it, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.SemiBold, color = if (late) error else MaterialTheme.colorScheme.onSurface, modifier = Modifier.padding(top = 4.dp)) }
    answer.catchArrive?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = if (late) error else muted) }
    // A busy bus and an estimate are small print, not more headlines.
    listOfNotNull(answer.leaveNote, answer.card?.estimate).takeIf { it.isNotEmpty() }?.let {
        Text(it.joinToString(" "), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 4.dp))
    }
    answer.goNowLine?.let {
        HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
        Text(it, style = MaterialTheme.typography.bodyMedium, color = muted)
    }
    answer.qualityText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 6.dp)) }
}

/**
 * The day's done, or there's nothing to catch: the label large, what's next
 * on a card of its own, then your favourites to plan a trip to instead. On
 * Now it's all up in the sky ([SkyHead]), the favourites on the ground
 * below the horizon, under the hour's sky. Elsewhere, a panel: the night's
 * after your day, else a plain one.
 */
@Composable
private fun DayDone(answer: NextAnswer, night: Boolean, onPlace: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val upcoming = answer.card?.upcoming
    // The line under the label: why today's empty on a break, or what's next when there's no card for it.
    val sub = upcoming?.off ?: answer.detail.takeIf { upcoming == null && it.isNotEmpty() }
    val places = answer.places.isNotEmpty()
    val sky = LocalSky.current
    if (sky != null) {
        SkyHead(72.dp) {
            Text(answer.label, color = MaterialTheme.colorScheme.onSurface, fontSize = 46.sp, lineHeight = 48.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-1).sp)
            sub?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 4.dp)) }
            upcoming?.let { UpcomingCard(it, glass = true) }
        }
        SkyGround()
        // On the ground, in the page's colours.
        if (places) Label(stringResource(R.string.going_anyway), Modifier.padding(top = 4.dp, bottom = 10.dp))
    } else if (night) {
        // With no sky to sit in, the night is a panel of its own.
        NightTheme(true) {
            Column(
                Modifier
                    .fillMaxWidth()
                    .clip(RoundedCornerShape(28.dp))
                    .background(Brush.verticalGradient(NIGHT))
                    .padding(horizontal = 22.dp)
                    .drawBehind { starsAndMoon(108.dp.toPx()) }
                    .padding(top = 108.dp, bottom = if (!places) 24.dp else 0.dp),
            ) {
                val ink = MaterialTheme.colorScheme
                Text(answer.label, color = ink.onSurface, fontSize = 46.sp, lineHeight = 48.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-1).sp)
                sub?.let { Text(it, color = ink.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp)) }
                upcoming?.let { UpcomingCard(it, glass = true) }
                if (places) Label(stringResource(R.string.going_anyway), Modifier.padding(top = 24.dp, bottom = 10.dp), color = ink.onSurfaceVariant)
            }
        }
    } else {
        Column(Modifier.fillMaxWidth().clip(RoundedCornerShape(28.dp)).background(c.surfaceVariant).padding(start = 22.dp, end = 22.dp, top = 28.dp, bottom = 24.dp)) {
            Text(answer.label, color = c.onSurface, fontSize = 38.sp, lineHeight = 42.sp, fontWeight = FontWeight.ExtraBold, letterSpacing = (-0.5).sp)
            sub?.let { Text(it, color = c.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp)) }
        }
        upcoming?.let { UpcomingCard(it, glass = false) }
        if (places) Label(stringResource(R.string.going_anyway), Modifier.padding(top = 22.dp, bottom = 10.dp))
    }
    if (places) {
        for (row in answer.places.chunked(3)) {
            Row(Modifier.fillMaxWidth().padding(bottom = 8.dp).height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                for (p in row) {
                    LinkTile({ onPlace(p.key) }, Modifier.weight(1f).fillMaxHeight()) {
                        Text(p.label, style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.Bold, maxLines = 2, overflow = TextOverflow.Ellipsis)
                        Spacer(Modifier.height(18.dp))
                        Text(stringResource(R.string.plan_trip), style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant)
                    }
                }
                repeat(3 - row.size) { Spacer(Modifier.weight(1f)) }
            }
        }
    } else {
        Text(
            stringResource(if (night) R.string.rest_hint_none else R.string.free_hint_none),
            style = MaterialTheme.typography.bodySmall, color = c.onSurfaceVariant, modifier = Modifier.padding(top = 12.dp),
        )
    }
}

/**
 * The next class on a card of its own: when in the accent, what, then
 * where. On the sky ([glass]) it's see-through: frosted on a light sky, a
 * faint pane on a dark one.
 */
@Composable
private fun UpcomingCard(u: Upcoming, glass: Boolean) {
    val c = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(22.dp)
    val light = LocalSky.current?.palette?.lightInk ?: true
    Column(
        Modifier
            .padding(top = 18.dp)
            .fillMaxWidth()
            .clip(shape)
            .background(if (!glass) c.surface else if (light) Color.White.copy(alpha = 0.06f) else Color.White.copy(alpha = 0.5f))
            .border(1.dp, if (!glass) c.outlineVariant else if (light) Color.White.copy(alpha = 0.14f) else Color(0x291C1917), shape)
            .padding(18.dp),
    ) {
        Label(u.whenText, color = smallAccent())
        Text(u.title, fontSize = 22.sp, lineHeight = 26.sp, fontWeight = FontWeight.Bold, color = c.onSurface, modifier = Modifier.padding(top = 6.dp))
        Text(u.where, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
    }
}

/** "On time" green: the sky's in the sky, else the one for the scheme's page (night's on a light phone too). */
@Composable
internal fun goodColor() = LocalSkyTones.current?.good ?: if (MaterialTheme.colorScheme.background.luminance() < 0.5f) GoodDark else GoodLight

/** "Leave by 09:38 · D2 from PGP", turning into "Leave now" when the time comes. */
@Composable
internal fun LeaveLine(answer: NextAnswer) {
    val at = answer.leaveAtMs ?: return
    val ctx = LocalContext.current
    val now by produceState(ServerClock.now(), at) {
        while (value < at) {
            delay((at - value).coerceIn(1_000, 30_000))
            value = ServerClock.now()
        }
    }
    answer.leaveText(now)?.let {
        Text(it, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
    }
}

/** Ticks every second from `departsAt`, so the app never shows an old "4 min". */
@Composable
internal fun Countdown(answer: NextAnswer) {
    val at = answer.departsAtMs ?: return
    val now by produceState(ServerClock.now(), at) {
        while (true) {
            value = ServerClock.now()
            delay(1_000)
        }
    }
    val left = (at - now) / 1000
    val text = when {
        left > 60 -> stringResource(R.string.leaves_in_min_s, (left / 60).toInt(), (left % 60).toInt())
        left > 0 -> stringResource(R.string.leaves_in_s, left.toInt())
        else -> stringResource(R.string.left_ago, ((-left + 59) / 60).toInt())
    }
    Text(text, style = MaterialTheme.typography.titleSmall, color = if (left > 0) smallAccent() else MaterialTheme.colorScheme.onSurfaceVariant)
}

/** Three states, three colours: "tight" is the one that must not look calm. */
@Composable
internal fun timingColor(status: String?) = when (status) {
    "late" -> MaterialTheme.colorScheme.error
    "tight" -> MaterialTheme.colorScheme.tertiary
    else -> goodColor()
}

/** Words in a colour of their own (a notice, a warning); in the sky, on its chip, so they read over any hour's colours. */
@Composable
private fun ToneText(text: String, color: Color, style: TextStyle = LocalTextStyle.current, fontWeight: FontWeight? = null) {
    val chip = LocalSkyTones.current?.chip
    Text(
        text,
        style = style,
        fontWeight = fontWeight,
        color = color,
        modifier = if (chip == null) Modifier else Modifier.background(chip, RoundedCornerShape(10.dp)).padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
internal fun Pill(text: String, color: Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = color,
        modifier = Modifier
            // In the sky, on its chip, so the colour reads over any hour's (SkyTones).
            .background(LocalSkyTones.current?.chip ?: color.copy(alpha = 0.12f), RoundedCornerShape(50))
            .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

/** On the bus: a bar from boarding to getting off, and "Next: Opp NUSS · 3 stops to go". */
@Composable
private fun RideProgress(ride: Ride) {
    val now by produceState(ServerClock.now(), ride) {
        while (value < ride.arriveMs) {
            delay(5_000)
            value = ServerClock.now()
        }
    }
    LinearProgressIndicator(
        progress = { ride.progress(now) },
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    )
    Text(ride.nextText(now), style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(top = 4.dp, bottom = 4.dp))
}
