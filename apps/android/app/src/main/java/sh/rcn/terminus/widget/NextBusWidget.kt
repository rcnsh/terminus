package sh.rcn.terminus.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.ColorFilter
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.ActionParameters
import androidx.glance.action.actionStartActivity
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.compose.runtime.remember
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.currentState
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import sh.rcn.terminus.NextAnswer
import sh.rcn.terminus.R
import sh.rcn.terminus.Store
import sh.rcn.terminus.ui.BrandDark
import sh.rcn.terminus.ui.BrandLight
import sh.rcn.terminus.ui.MainActivity
import sh.rcn.terminus.ui.qualityNote
import java.util.Date

/**
 * Two widgets in the picker. "Next bus" is one glanceable line; "Next bus +
 * places" adds the alternative and one-tap buttons for saved places.
 */
abstract class BaseWidget(private val large: Boolean) : GlanceAppWidget() {

    override val sizeMode = SizeMode.Exact

    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = Store(context)
        provideContent {
            // redrawWidgets() bumps VERSION. Reading the cache keyed on it is
            // what makes a running Glance session pick up a new answer; values
            // read once outside the composition would stay stale.
            val version = currentState(VERSION) ?: 0L
            val snap = remember(version) { Snap(store.paired, store.lastAnswer(), store.lastError) }
            GlanceTheme(colors = BrandColors) {
                Content(snap.paired, snap.last?.first, snap.last?.second, snap.error)
            }
        }
    }

    private data class Snap(val paired: Boolean, val last: Pair<NextAnswer, Long>?, val error: String?)

    @Composable
    private fun Content(paired: Boolean, answer: NextAnswer?, fetchedAt: Long?, error: String?) {
        val ctx = LocalContext.current
        val colors = GlanceTheme.colors
        val muted = TextStyle(color = colors.onSurfaceVariant, fontSize = 12.sp)
        val tiny = TextStyle(color = colors.onSurfaceVariant, fontSize = 11.sp)
        // Layout follows the real size: a compact widget stretched to two
        // rows gets the full layout rather than one line in a big box.
        val height = LocalSize.current.height
        val large = large || height >= 110.dp
        val roomy = large || height >= 90.dp

        // TalkBack reads the widget as one sentence instead of fragments.
        val spoken = spokenSummary(ctx, paired, answer, fetchedAt, error)
        Column(
            modifier = GlanceModifier
                .fillMaxSize()
                .semantics { contentDescription = spoken }
                .background(colors.widgetBackground)
                .cornerRadius(20.dp)
                .padding(horizontal = 14.dp, vertical = if (large) 12.dp else 8.dp)
                .clickable(if (paired) actionRunCallback<RefreshAction>() else actionStartActivity<MainActivity>()),
            verticalAlignment = if (large) Alignment.Top else Alignment.CenterVertically,
        ) {
            when {
                !paired -> {
                    Text("terminus", style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 16.sp))
                    Text(error ?: "Tap to pair this phone", style = muted, maxLines = 2)
                }
                answer == null -> {
                    Text(error ?: "Loading…", style = TextStyle(color = colors.onSurface, fontSize = 16.sp))
                    Text("Tap to refresh", style = muted)
                }
                answer.arrived -> {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(
                            provider = ImageProvider(R.drawable.ic_check),
                            contentDescription = null,
                            colorFilter = ColorFilter.tint(colors.primary),
                            modifier = GlanceModifier.size(if (large) 22.dp else 18.dp),
                        )
                        Spacer(GlanceModifier.width(8.dp))
                        Text(answer.label, style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 22.sp else 18.sp), maxLines = 1)
                    }
                    Text(answer.detail, style = muted, maxLines = if (large) 2 else 1)
                    if (large) {
                        Spacer(GlanceModifier.defaultWeight())
                        Chips(ctx, answer)
                    }
                }
                answer.mode == "rest" -> {
                    // Outside the user's day: a moon and the next class, no bus.
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(
                            provider = ImageProvider(R.drawable.ic_moon),
                            contentDescription = null,
                            colorFilter = ColorFilter.tint(colors.primary),
                            modifier = GlanceModifier.size(if (large) 22.dp else 18.dp),
                        )
                        Spacer(GlanceModifier.width(8.dp))
                        Text(
                            answer.label,
                            style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 22.sp else 18.sp),
                            maxLines = 1,
                        )
                    }
                    Text(answer.detail, style = muted, maxLines = if (large) 2 else 1)
                    if (large) {
                        Spacer(GlanceModifier.defaultWeight())
                        Chips(ctx, answer)
                    }
                }
                else -> {
                    val heading = listOfNotNull(
                        answer.destLabel ?: if (answer.mode == "nearby") "Nearby" else null,
                        if (answer.why == "gap-home") "long gap" else null,
                    ).joinToString(" · ")
                    if (heading.isNotEmpty()) Text(heading, style = muted, maxLines = 1)
                    // A clock time stays true until the bus leaves; "4 min"
                    // is wrong a minute later. Once the bus has gone, or the
                    // data is old, dim it and ask for a tap rather than lie.
                    val now = System.currentTimeMillis()
                    val old = isOld(answer, fetchedAt, now)
                    Text(
                        answer.clockLabel { clock(ctx, it) },
                        style = TextStyle(
                            color = if (old) colors.onSurfaceVariant else colors.onSurface,
                            fontWeight = FontWeight.Bold,
                            fontSize = if (large) 24.sp else 20.sp,
                        ),
                        maxLines = 1,
                    )
                    // A compact widget has no footer, so a problem goes on this line.
                    val line = when {
                        error == UPDATING -> UPDATING
                        old -> "Old times · tap to refresh"
                        error != null && !roomy -> "$error · ${answer.detail}"
                        else -> answer.detail
                    }
                    Text(line, style = muted, maxLines = if (large) 2 else 1)
                    if (large && !old) {
                        // Crowd is already in the detail line; only the data quality is new here.
                        qualityNote(answer.quality)?.let { Text(it, style = muted, maxLines = 1) }
                        answer.timingText?.let { Text(it, style = TextStyle(color = timingColor(answer.timingStatus, colors), fontSize = 12.sp, fontWeight = FontWeight.Medium), maxLines = 1) }
                    }
                    if (large) {
                        Spacer(GlanceModifier.defaultWeight())
                        Chips(ctx, answer)
                        Spacer(GlanceModifier.height(6.dp))
                    }
                    val stamp = fetchedAt?.let { "Updated ${clock(ctx, it)}" }
                    val foot = listOfNotNull(error?.takeIf { it != UPDATING }, stamp).joinToString(" · ")
                    if (roomy && foot.isNotEmpty()) Text(foot, style = tiny, maxLines = 1)
                }
            }
        }
    }

    private fun timingColor(status: String?, colors: androidx.glance.color.ColorProviders) = when (status) {
        "late" -> colors.error
        "tight" -> colors.tertiary
        else -> colors.primary
    }

    @Composable
    private fun Chips(ctx: Context, answer: NextAnswer) {
        val colors = GlanceTheme.colors
        Row(modifier = GlanceModifier.fillMaxWidth()) {
            val chips = answer.places.take(3).map { it.label to MainActivity.intentFor(ctx, place = it.key) } +
                ("Nearby" to MainActivity.intentFor(ctx, nearby = true))
            chips.forEachIndexed { i, (label, intent) ->
                if (i > 0) Spacer(GlanceModifier.width(6.dp))
                Box(
                    modifier = GlanceModifier
                        .background(colors.secondaryContainer)
                        .cornerRadius(14.dp)
                        .padding(horizontal = 14.dp, vertical = 10.dp)
                        .semantics { contentDescription = "$label: open the app" }
                        .clickable(actionStartActivity(intent)),
                ) {
                    Text(label, style = TextStyle(color = colors.onSecondaryContainer, fontSize = 13.sp), maxLines = 1)
                }
            }
        }
    }
}

/** What the widget says, as a sentence for screen readers. */
fun spokenSummary(ctx: Context, paired: Boolean, answer: NextAnswer?, fetchedAt: Long?, error: String?): String {
    if (!paired) return "terminus. Not paired. Double tap to pair this phone."
    if (answer == null) return "terminus. ${error ?: "Loading"}. Double tap to refresh."
    val old = isOld(answer, fetchedAt, System.currentTimeMillis())
    val parts = listOfNotNull(
        answer.destLabel?.let { "To $it" },
        if (answer.mode == "rest") answer.label else answer.clockLabel { clock(ctx, it) }.replace(" · ", ", leaves "),
        if (old) "These times are old" else answer.detail.replace(" · ", ", "),
        answer.timingText?.takeIf { !old },
        error?.takeIf { it != UPDATING },
    )
    return parts.joinToString(". ") + ". Double tap to refresh."
}

/** The app's brand colours, so the widget doesn't take the wallpaper's. */
private val BrandColors = androidx.glance.material3.ColorProviders(light = BrandLight, dark = BrandDark)

class NextBusWidget : BaseWidget(large = false)
class PlacesWidget : BaseWidget(large = true)

private val VERSION = longPreferencesKey("version")

/** Redraws every placed widget of both kinds with the latest cached answer. */
suspend fun redrawWidgets(ctx: Context) {
    val mgr = GlanceAppWidgetManager(ctx)
    for (widget in listOf(NextBusWidget(), PlacesWidget())) {
        for (id in mgr.getGlanceIds(widget.javaClass)) {
            updateAppWidgetState(ctx, id) { it[VERSION] = System.currentTimeMillis() }
            widget.update(ctx, id)
        }
    }
}

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        // Show that the tap landed before the network answers.
        Store(context).lastError = UPDATING
        redrawWidgets(context)
        Refresher.refresh(context, fast = true)
    }
}

const val UPDATING = "Updating…"

open class BusWidgetReceiver(widget: GlanceAppWidget) : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = widget

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Refresher.schedule(context)
        Refresher.refreshSoon(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        // Called when the last widget of THIS kind goes. Keep refreshing
        // while a widget of the other kind is still on the home screen.
        if (Refresher.widgetCount(context) == 0) Refresher.cancel(context)
    }
}

class NextBusWidgetReceiver : BusWidgetReceiver(NextBusWidget())
class PlacesWidgetReceiver : BusWidgetReceiver(PlacesWidget())

/**
 * Past this, an answer is refreshed, and dimmed if the refresh hasn't landed.
 * A clock time stays true until the bus leaves, so this is only the backstop
 * for relative text ("or A1 9 min") and missed refreshes.
 */
const val MAX_AGE_MS = 15 * 60_000L
/** A bus shown as leaving at 09:42 might still be at the stop at 09:42:20. */
const val DEPARTED_GRACE_MS = 30_000L

/**
 * The bus in the answer has left, the plan has moved on (a class started, the
 * day ended), or the answer is past MAX_AGE_MS. A rest answer only goes old
 * when the day starts.
 */
fun isOld(answer: NextAnswer, fetchedAt: Long?, now: Long): Boolean {
    if (answer.refreshAtMs?.let { now >= it } == true) return true
    if (answer.mode == "rest") return false
    val departed = answer.departsAtMs?.let { now > it + DEPARTED_GRACE_MS } ?: false
    val aged = fetchedAt != null && now - fetchedAt > MAX_AGE_MS
    return departed || aged
}

/**
 * Campus time, in the phone's 12/24-hour style. Class times and "Arrive
 * 09:52" come from the server in Singapore time; a phone set to another
 * zone must not print the bus in a different one beside them.
 */
fun clock(ctx: Context, ms: Long): String =
    android.text.format.DateFormat.getTimeFormat(ctx)
        .apply { timeZone = java.util.TimeZone.getTimeZone("Asia/Singapore") }
        .format(Date(ms))
