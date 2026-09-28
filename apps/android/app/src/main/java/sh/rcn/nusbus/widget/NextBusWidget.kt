package sh.rcn.nusbus.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
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
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import sh.rcn.nusbus.NextAnswer
import sh.rcn.nusbus.Store
import sh.rcn.nusbus.ui.MainActivity
import java.text.DateFormat
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
            GlanceTheme {
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
        val tiny = TextStyle(color = colors.onSurfaceVariant, fontSize = 10.sp)
        // Layout follows the real size: a compact widget stretched to two
        // rows gets the full layout rather than one line in a big box.
        val height = LocalSize.current.height
        val large = large || height >= 110.dp
        val roomy = large || height >= 90.dp

        Column(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(colors.widgetBackground)
                .cornerRadius(20.dp)
                .padding(horizontal = 14.dp, vertical = if (large) 12.dp else 8.dp)
                .clickable(if (paired) actionRunCallback<RefreshAction>() else actionStartActivity<MainActivity>()),
            verticalAlignment = if (large) Alignment.Top else Alignment.CenterVertically,
        ) {
            when {
                !paired -> {
                    Text("nusbus", style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 16.sp))
                    Text(error ?: "Tap to pair this phone", style = muted, maxLines = 2)
                }
                answer == null -> {
                    Text(error ?: "Loading…", style = TextStyle(color = colors.onSurface, fontSize = 16.sp))
                    Text("Tap to refresh", style = muted)
                }
                else -> {
                    val heading = listOfNotNull(
                        answer.destLabel ?: if (answer.mode == "nearby") "Nearby" else null,
                        if (answer.why == "gap-home") "long gap" else null,
                    ).joinToString(" · ")
                    if (heading.isNotEmpty()) Text(heading, style = muted, maxLines = 1)
                    Text(
                        answer.label,
                        style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = if (large) 24.sp else 20.sp),
                        maxLines = 1,
                    )
                    Text(answer.detail, style = muted, maxLines = if (large) 2 else 1)
                    if (large) {
                        answer.alt?.let { Text("Or: $it", style = muted, maxLines = 1) }
                        Spacer(GlanceModifier.defaultWeight())
                        Chips(ctx, answer)
                        Spacer(GlanceModifier.height(6.dp))
                    }
                    val stamp = fetchedAt?.let { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it)) }
                    val foot = listOfNotNull(error, stamp).joinToString(" · ")
                    if (roomy && foot.isNotEmpty()) Text(foot, style = tiny, maxLines = 1)
                }
            }
        }
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
                        .padding(horizontal = 12.dp, vertical = 7.dp)
                        .clickable(actionStartActivity(intent)),
                ) {
                    Text(label, style = TextStyle(color = colors.onSecondaryContainer, fontSize = 13.sp), maxLines = 1)
                }
            }
        }
    }
}

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
        Refresher.refresh(context)
    }
}

open class BusWidgetReceiver(widget: GlanceAppWidget) : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = widget

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Refresher.schedule(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        // Called when the last widget of THIS kind goes. Keep refreshing
        // while a widget of the other kind is still on the home screen.
        val mgr = AppWidgetManager.getInstance(context)
        val left = listOf(NextBusWidgetReceiver::class.java, PlacesWidgetReceiver::class.java)
            .sumOf { mgr.getAppWidgetIds(ComponentName(context, it)).size }
        if (left == 0) Refresher.cancel(context)
    }
}

class NextBusWidgetReceiver : BusWidgetReceiver(NextBusWidget())
class PlacesWidgetReceiver : BusWidgetReceiver(PlacesWidget())
