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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
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
import sh.rcn.terminus.ServerClock
import sh.rcn.terminus.Spoken
import sh.rcn.terminus.Step
import sh.rcn.terminus.StepTarget
import sh.rcn.terminus.Suggestion
import sh.rcn.terminus.Upcoming
import sh.rcn.terminus.widget.clock
import sh.rcn.terminus.widget.isOld

@Composable
internal fun AnswerCard(
    answer: NextAnswer?,
    loading: Boolean,
    onAction: (CardAction) -> Unit = {},
    busy: Boolean = false,
    onSuggestion: (Suggestion, Boolean) -> Unit = { _, _ -> },
    onPlace: (String) -> Unit = {},
    onStep: (Step, StepTarget?, String?) -> Unit = { _, _, _ -> },
) {
    Box {
        Spoken.announcement(answer)?.let { said ->
            Box(
                Modifier.size(1.dp).semantics {
                    liveRegion = LiveRegionMode.Polite
                    contentDescription = said
                }
            )
        }
        Column(
            Modifier.fillMaxWidth().heightIn(min = 180.dp).padding(top = 4.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp),
        ) {
            if (answer == null) {
                if (loading) {
                    NowSkeleton()
                    return@Column
                }
                SkyHead { Text(stringResource(R.string.no_answer_yet), style = MaterialTheme.typography.titleLarge) }
                SkyGround()
                return@Column
            }
            if (answer.mode == "rest" || answer.isFree || answer.arrived) {
                DayDone(answer, night = answer.mode == "rest", onPlace)
                Actions(answer, onAction, busy, onSuggestion)
                return@Column
            }
            val lead: @Composable ColumnScope.() -> Unit = {
                answer.card?.notice?.let { ToneText(it, MaterialTheme.colorScheme.tertiary, MaterialTheme.typography.bodySmall) }
                answer.phaseText?.let { Pill(it, smallAccent()) }
                answer.card?.ride?.let { RideProgress(it) }
                answer.card?.warning?.let { ToneText(it, MaterialTheme.colorScheme.tertiary, fontWeight = FontWeight.SemiBold) }
            }
            val old = stale(answer)
            answer.card
                ?.journey
                ?.takeIf { !answer.arrived && !old }
                ?.let { journey ->
                    val said = spokenCard(answer, withLead = true)
                    Column(
                        Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = said },
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                    ) {
                        JourneyCard(answer, journey, CardStyle.pref(LocalContext.current), lead)
                    }
                    StepBus(answer, onStep, busy)
                    Actions(answer, onAction, busy, onSuggestion)
                    return@Column
                }
            if (answer.isClassPlan && !old) {
                val said = spokenCard(answer, withLead = true)
                Column(
                    Modifier.fillMaxWidth().clearAndSetSemantics { contentDescription = said },
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
                    SkyHead {
                        lead()
                        ClassPlan(answer)
                    }
                }
                SkyGround()
                StepBus(answer, onStep, busy)
                Actions(answer, onAction, busy, onSuggestion)
                return@Column
            }
            val head =
                answer.card?.heading
                    ?: when {
                        answer.mode == "nearby" -> stringResource(R.string.chip_nearby)
                        answer.why == "gap-home" -> stringResource(R.string.long_gap, answer.destLabel.orEmpty())
                        else -> answer.destLabel
                    }
            SkyHead {
                lead()
                head?.let { Text(it, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.semantics { heading() }) }
                val ctx = LocalContext.current
                val muted = MaterialTheme.colorScheme.onSurfaceVariant
                val said = if (old) null else spokenCard(answer, withLead = false)
                Column(
                    if (said == null) Modifier else Modifier.clearAndSetSemantics { contentDescription = said },
                    verticalArrangement = Arrangement.spacedBy(4.dp),
                ) {
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
                        answer.timingText?.takeIf { !old && answer.card?.ride == null }?.let { Pill(it, timingColor(answer.timingStatus)) }
                        answer.crowdText?.let { Pill(it, muted) }
                    }
                    answer.qualityText?.let {
                        Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
            }
            SkyGround()
            if (!old) StepBus(answer, onStep, busy)
            Actions(answer, onAction, busy, onSuggestion)
        }
    }
}

@Composable
private fun spokenCard(answer: NextAnswer, withLead: Boolean): String {
    val ctx = LocalContext.current
    val now by
        produceState(ServerClock.now(), answer) {
            while (true) {
                value = ServerClock.now()
                delay(10_000)
            }
        }
    val lead = if (!withLead) emptyList() else listOfNotNull(answer.card?.notice, answer.card?.warning)
    return listOfNotNull(
            lead.joinToString("") { "${Spoken.spell(it).trimEnd('.', '。')}. " }.ifEmpty { null },
            Spoken.summary(true, answer, null, now, withHead = withLead) { clock(ctx, it) },
            Spoken.countdown(answer, now)?.let { "$it." },
        )
        .joinToString(" ")
}

@Composable
private fun stale(answer: NextAnswer): Boolean {
    val old by
        produceState(isOld(answer, ServerClock.now()), answer) {
            value = isOld(answer, ServerClock.now())
            while (!value) {
                val at = answer.card?.staleAtMs ?: break
                delay((at - ServerClock.now()).coerceIn(50, 60_000))
                value = isOld(answer, ServerClock.now())
            }
        }
    return old
}

internal fun withoutLocalUndo(answer: NextAnswer?, undoing: String?): NextAnswer? {
    val card = answer?.card ?: return answer
    if (undoing == null || card.actions.none { it.id == "reset" && it.trip == undoing }) return answer
    return answer.copy(card = card.copy(actions = card.actions.filterNot { it.id == "reset" && it.trip == undoing }))
}

@Composable
private fun StepBus(answer: NextAnswer, onStep: (Step, StepTarget?, String?) -> Unit, busy: Boolean) {
    val step = answer.card?.step ?: return
    Row(Modifier.fillMaxWidth().padding(top = 10.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        val wide = Modifier.weight(1f).heightIn(min = 48.dp)
        val pad = PaddingValues(horizontal = 8.dp)
        OutlinedButton(
            onClick = { onStep(step, step.earlier, "earlier") },
            enabled = !busy && step.earlier != null,
            modifier = wide,
            contentPadding = pad,
        ) {
            Arrow("‹")
            Text(step.earlierLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        if (step.moved)
            OutlinedButton(onClick = { onStep(step, null, null) }, enabled = !busy, modifier = wide, contentPadding = pad) {
                Text(step.bestLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        OutlinedButton(
            onClick = { onStep(step, step.later, "later") },
            enabled = !busy && step.later != null,
            modifier = wide,
            contentPadding = pad,
        ) {
            Text(step.laterLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Arrow("›")
        }
    }
}

@Composable private fun Arrow(glyph: String) = Text(glyph, Modifier.padding(horizontal = 4.dp).clearAndSetSemantics {})

@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun Actions(
    answer: NextAnswer,
    onAction: (CardAction) -> Unit,
    busy: Boolean,
    onSuggestion: (Suggestion, Boolean) -> Unit = { _, _ -> },
) {
    val walkTo = answer.card?.walkTo
    val all = answer.card?.actions.orEmpty()
    val skips = all.filter { it.id == "skipped" || it.id == "away" }.takeIf { it.size > 1 }.orEmpty()
    val actions = all - skips.toSet()
    walkTo?.let { w ->
        val ctx = LocalContext.current
        Row(Modifier.fillMaxWidth().padding(top = 14.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                onClick = { runCatching { ctx.startActivity(Intent(Intent.ACTION_VIEW, w.mapsUri())) } },
                modifier = Modifier.weight(1f).heightIn(min = 48.dp),
            ) {
                Text(stringResource(R.string.directions_to, w.name), maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            if (skips.isNotEmpty()) SkipMenu(skips, onAction, busy, label = null)
            else
                actions.firstOrNull()?.let { a ->
                    OutlinedButton(onClick = { onAction(a) }, enabled = !busy, modifier = Modifier.heightIn(min = 48.dp)) {
                        Text(a.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
                    }
                }
        }
    }
    val rest = if (walkTo != null && skips.isEmpty()) actions.drop(1) else actions
    val skipButton = walkTo == null && skips.isNotEmpty()
    if (rest.isNotEmpty() || skipButton) {
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(8.dp),
            modifier = Modifier.padding(top = if (walkTo != null) 6.dp else 10.dp),
        ) {
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

@Composable
private fun SkipMenu(skips: List<CardAction>, onAction: (CardAction) -> Unit, busy: Boolean, label: String?) {
    var open by remember { mutableStateOf(false) }
    Box {
        if (label == null) {
            OutlinedButton(
                onClick = { open = true },
                enabled = !busy,
                modifier = Modifier.size(48.dp),
                contentPadding = PaddingValues(0.dp),
            ) {
                Icon(
                    painterResource(R.drawable.ic_more),
                    contentDescription = stringResource(R.string.more_options),
                    modifier = Modifier.size(20.dp),
                )
            }
        } else {
            OutlinedButton(onClick = { open = true }, enabled = !busy) { Text(label) }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            skips.forEach { a ->
                val hint =
                    when (a.id) {
                        "skipped" -> stringResource(R.string.skips_class)
                        "away" -> stringResource(R.string.skips_day)
                        else -> null
                    }
                DropdownMenuItem(
                    text = {
                        Column(Modifier.padding(vertical = 4.dp)) {
                            Text(a.label, style = MaterialTheme.typography.bodyLarge)
                            hint?.let {
                                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                    },
                    onClick = {
                        open = false
                        onAction(a)
                    },
                )
            }
        }
    }
}

@Composable
internal fun ClassPlan(answer: NextAnswer) {
    val ctx = LocalContext.current
    val at = answer.leaveAtMs ?: return
    val fmt = { ms: Long -> clock(ctx, ms) }
    val now by
        produceState(ServerClock.now(), at) {
            while (true) {
                value = ServerClock.now()
                delay(if (at - value < 120_000) 1_000 else 15_000)
            }
        }
    val late = answer.leaveLate
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    val starts = answer.classAtMs?.let { stringResource(answer.startsRes, fmt(it)) }
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
    val left = if (answer.card?.phase == "waiting") 0 else (at - now) / 1000
    if (left > 0) {
        Text(
            when {
                left >= 120 -> stringResource(R.string.in_min, ((left + 30) / 60).toInt())
                left >= 60 -> stringResource(R.string.in_min_s, (left / 60).toInt(), (left % 60).toInt())
                else -> stringResource(R.string.in_s, left.toInt())
            },
            style = MaterialTheme.typography.titleSmall,
            color = smallAccent(),
        )
    }
    val error = MaterialTheme.colorScheme.error
    answer.catchHow?.let {
        Text(
            it,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (late) error else MaterialTheme.colorScheme.onSurface,
            modifier = Modifier.padding(top = 4.dp),
        )
    }
    answer.catchArrive?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = if (late) error else muted) }
    listOfNotNull(answer.leaveNote, answer.card?.estimate)
        .takeIf { it.isNotEmpty() }
        ?.let {
            Text(it.joinToString(" "), style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 4.dp))
        }
    answer.goNowLine?.let {
        HorizontalDivider(Modifier.padding(vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
        Text(it, style = MaterialTheme.typography.bodyMedium, color = muted)
    }
    answer.qualityText?.let { Text(it, style = MaterialTheme.typography.bodySmall, color = muted, modifier = Modifier.padding(top = 6.dp)) }
}

@Composable
private fun DayDone(answer: NextAnswer, night: Boolean, onPlace: (String) -> Unit) {
    val c = MaterialTheme.colorScheme
    val upcoming = answer.card?.upcoming
    val sub = upcoming?.off ?: answer.detail.takeIf { upcoming == null && it.isNotEmpty() }
    val places = answer.places.isNotEmpty()
    val sky = LocalSky.current
    if (sky != null) {
        SkyHead(72.dp) {
            Text(
                answer.label,
                color = MaterialTheme.colorScheme.onSurface,
                fontSize = 46.sp,
                lineHeight = 48.sp,
                fontWeight = FontWeight.ExtraBold,
                letterSpacing = (-1).sp,
            )
            sub?.let {
                Text(
                    it,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    style = MaterialTheme.typography.bodyLarge,
                    modifier = Modifier.padding(top = 4.dp),
                )
            }
            upcoming?.let { UpcomingCard(it, glass = true) }
        }
        SkyGround()
        if (places) Label(stringResource(R.string.going_anyway), Modifier.padding(top = 4.dp, bottom = 10.dp))
    } else if (night) {
        NightTheme(true) {
            Column(
                Modifier.fillMaxWidth()
                    .clip(RoundedCornerShape(28.dp))
                    .background(Brush.verticalGradient(NIGHT))
                    .padding(horizontal = 22.dp)
                    .drawBehind { starsAndMoon(108.dp.toPx()) }
                    .padding(top = 108.dp, bottom = if (!places) 24.dp else 0.dp)
            ) {
                val ink = MaterialTheme.colorScheme
                Text(
                    answer.label,
                    color = ink.onSurface,
                    fontSize = 46.sp,
                    lineHeight = 48.sp,
                    fontWeight = FontWeight.ExtraBold,
                    letterSpacing = (-1).sp,
                )
                sub?.let {
                    Text(
                        it,
                        color = ink.onSurfaceVariant,
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(top = 8.dp),
                    )
                }
                upcoming?.let { UpcomingCard(it, glass = true) }
                if (places)
                    Label(
                        stringResource(R.string.going_anyway),
                        Modifier.padding(top = 24.dp, bottom = 10.dp),
                        color = ink.onSurfaceVariant,
                    )
            }
        }
    } else {
        Column(
            Modifier.fillMaxWidth()
                .clip(RoundedCornerShape(28.dp))
                .background(c.surfaceVariant)
                .padding(start = 22.dp, end = 22.dp, top = 28.dp, bottom = 24.dp)
        ) {
            Text(
                answer.label,
                color = c.onSurface,
                fontSize = 38.sp,
                lineHeight = 42.sp,
                fontWeight = FontWeight.ExtraBold,
                letterSpacing = (-0.5).sp,
            )
            sub?.let {
                Text(it, color = c.onSurfaceVariant, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.padding(top = 8.dp))
            }
        }
        upcoming?.let { UpcomingCard(it, glass = false) }
        if (places) Label(stringResource(R.string.going_anyway), Modifier.padding(top = 22.dp, bottom = 10.dp))
    }
    if (places) {
        for (row in answer.places.chunked(3)) {
            Row(
                Modifier.fillMaxWidth().padding(bottom = 8.dp).height(IntrinsicSize.Min),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
            ) {
                for (p in row) {
                    LinkTile({ onPlace(p.key) }, Modifier.weight(1f).fillMaxHeight()) {
                        Text(
                            p.label,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                        )
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
            style = MaterialTheme.typography.bodySmall,
            color = c.onSurfaceVariant,
            modifier = Modifier.padding(top = 12.dp),
        )
    }
}

@Composable
private fun UpcomingCard(u: Upcoming, glass: Boolean) {
    val c = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(22.dp)
    val light = LocalSky.current?.palette?.lightInk ?: true
    Column(
        Modifier.padding(top = 18.dp)
            .fillMaxWidth()
            .clip(shape)
            .background(if (!glass) c.surface else if (light) Color.White.copy(alpha = 0.06f) else Color.White.copy(alpha = 0.5f))
            .border(1.dp, if (!glass) c.outlineVariant else if (light) Color.White.copy(alpha = 0.14f) else Color(0x291C1917), shape)
            .padding(18.dp)
    ) {
        Label(u.whenText, color = smallAccent())
        Text(
            u.title,
            fontSize = 22.sp,
            lineHeight = 26.sp,
            fontWeight = FontWeight.Bold,
            color = c.onSurface,
            modifier = Modifier.padding(top = 6.dp),
        )
        Text(u.where, style = MaterialTheme.typography.bodyMedium, color = c.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
internal fun goodColor() =
    LocalSkyTones.current?.good ?: if (MaterialTheme.colorScheme.background.luminance() < 0.5f) GoodDark else GoodLight

@Composable
internal fun LeaveLine(answer: NextAnswer) {
    val at = answer.leaveAtMs ?: return
    val ctx = LocalContext.current
    val now by
        produceState(ServerClock.now(), at) {
            while (value < at) {
                delay((at - value).coerceIn(1_000, 30_000))
                value = ServerClock.now()
            }
        }
    answer.leaveText(now)?.let {
        Text(it, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold, modifier = Modifier.padding(top = 4.dp))
    }
}

@Composable
internal fun Countdown(answer: NextAnswer) {
    val at = answer.departsAtMs ?: return
    val now by
        produceState(ServerClock.now(), at) {
            while (true) {
                value = ServerClock.now()
                delay(1_000)
            }
        }
    val left = (at - now) / 1000
    val text =
        when {
            left > 60 -> stringResource(R.string.leaves_in_min_s, (left / 60).toInt(), (left % 60).toInt())
            left > 0 -> stringResource(R.string.leaves_in_s, left.toInt())
            else -> stringResource(R.string.left_ago, maxOf(1, ((-left + 59) / 60).toInt()))
        }
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = if (left > 0) smallAccent() else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

@Composable
internal fun timingColor(status: String?) =
    when (status) {
        "late" -> MaterialTheme.colorScheme.error
        "tight" -> MaterialTheme.colorScheme.tertiary
        else -> goodColor()
    }

@Composable
private fun ToneText(text: String, color: Color, style: TextStyle = LocalTextStyle.current, fontWeight: FontWeight? = null) {
    val chip = LocalSkyTones.current?.chip
    Text(
        text,
        style = style,
        fontWeight = fontWeight,
        color = color,
        modifier =
            if (chip == null) Modifier
            else Modifier.background(chip, RoundedCornerShape(10.dp)).padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
internal fun Pill(text: String, color: Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelMedium,
        color = color,
        modifier =
            Modifier.background(LocalSkyTones.current?.chip ?: color.copy(alpha = 0.12f), RoundedCornerShape(50))
                .padding(horizontal = 10.dp, vertical = 4.dp),
    )
}

@Composable
private fun RideProgress(ride: Ride) {
    val now by
        produceState(ServerClock.now(), ride) {
            while (value < ride.arriveMs) {
                delay(5_000)
                value = ServerClock.now()
            }
        }
    LinearProgressIndicator(
        progress = { ride.progress(now) },
        modifier = Modifier.fillMaxWidth().padding(top = 8.dp),
    )
    Text(
        ride.nextText(now, withChange = false),
        style = MaterialTheme.typography.bodyMedium,
        modifier = Modifier.padding(top = 4.dp, bottom = 4.dp),
    )
    ride.change?.let {
        Text(
            it.text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = 4.dp),
        )
    }
}

@Composable
private fun NowSkeleton() {
    Skeleton(stringResource(R.string.checking), Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        SkyHead {
            TextBar(LocalTextStyle.current, fraction = 0.62f, sky = true)
            TextBar(TextStyle(fontSize = 34.sp, lineHeight = 38.sp), Modifier.padding(vertical = 2.dp), fraction = 0.78f, sky = true)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                TextBar(LocalTextStyle.current, Modifier.weight(1f, fill = false), fraction = 0.5f, sky = true)
                Bar(Modifier.size(58.dp, 24.dp), RoundedCornerShape(50), sky = true)
            }
        }
        SkyGround()
        Column(Modifier.padding(top = 18.dp)) {
            SkeletonPoint(rail = true, title = 0.30f, below = 0.38f)
            SkeletonPoint(rail = true, title = 0.42f, below = 0.34f)
            SkeletonPoint(rail = false, title = 0.34f, below = null)
        }
    }
}

@Composable
private fun SkeletonPoint(rail: Boolean, title: Float, below: Float?) {
    val type = MaterialTheme.typography
    Row(Modifier.height(IntrinsicSize.Min)) {
        val wide = LocalDensity.current.fontScale.coerceIn(1f, 1.8f)
        TextBar(type.bodyMedium, Modifier.width(72.dp * wide).padding(top = 3.dp), width = 42.dp)
        Column(Modifier.width(26.dp).fillMaxHeight(), horizontalAlignment = Alignment.CenterHorizontally) {
            Bar(Modifier.padding(top = 7.dp).size(14.dp), CircleShape)
            if (rail) Bar(Modifier.padding(vertical = 6.dp).weight(1f).width(3.dp), RoundedCornerShape(2.dp))
        }
        Column(Modifier.weight(1f).padding(start = 10.dp, top = 1.dp, bottom = if (rail) 14.dp else 0.dp)) {
            TextBar(type.titleMedium, fraction = title)
            below?.let { TextBar(type.bodySmall, Modifier.padding(top = 6.dp), fraction = it) }
        }
    }
}
