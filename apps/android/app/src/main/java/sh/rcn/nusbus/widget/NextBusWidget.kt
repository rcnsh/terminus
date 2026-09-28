package sh.rcn.nusbus.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
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

class NextBusWidget : GlanceAppWidget() {

    private val small = DpSize(110.dp, 50.dp)
    private val tall = DpSize(180.dp, 110.dp)
    override val sizeMode = SizeMode.Responsive(setOf(small, tall))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = Store(context)
        val paired = store.paired
        val last = store.lastAnswer()
        val error = store.lastError
        provideContent {
            GlanceTheme {
                Content(paired, last?.first, last?.second, error)
            }
        }
    }

    @Composable
    private fun Content(paired: Boolean, answer: NextAnswer?, fetchedAt: Long?, error: String?) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val colors = GlanceTheme.colors
        val muted = TextStyle(color = colors.onSurfaceVariant, fontSize = 12.sp)

        Column(
            modifier = GlanceModifier
                .fillMaxSize()
                .background(colors.widgetBackground)
                .cornerRadius(20.dp)
                .padding(horizontal = 14.dp, vertical = 10.dp)
                .clickable(if (paired) actionRunCallback<RefreshAction>() else actionStartActivity<MainActivity>()),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            when {
                !paired -> {
                    Text("nusbus", style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 16.sp))
                    Text(error ?: "Tap to pair this phone", style = muted, maxLines = 2)
                }
                answer == null -> {
                    Text(if (error != null) error else "Loading…", style = TextStyle(color = colors.onSurface, fontSize = 16.sp))
                    Text("Tap to refresh", style = muted)
                }
                else -> {
                    val heading = listOfNotNull(answer.destLabel ?: if (answer.mode == "nearby") "Nearby" else null, whyText(answer.why))
                        .joinToString(" · ")
                    if (heading.isNotEmpty()) Text(heading, style = muted, maxLines = 1)
                    Text(
                        answer.label,
                        style = TextStyle(color = colors.onSurface, fontWeight = FontWeight.Bold, fontSize = 20.sp),
                        maxLines = 1,
                    )
                    val stamp = fetchedAt?.let { DateFormat.getTimeInstance(DateFormat.SHORT).format(Date(it)) }
                    val foot = listOfNotNull(error, stamp).joinToString(" · ")
                    Text(answer.detail, style = muted, maxLines = if (size.height >= tall.height) 2 else 1)
                    if (size.height >= tall.height) {
                        Spacer(GlanceModifier.height(8.dp))
                        Chips(ctx, answer)
                        Spacer(GlanceModifier.height(6.dp))
                    }
                    Text(foot, style = TextStyle(color = colors.onSurfaceVariant, fontSize = 10.sp), maxLines = 1)
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
                        .cornerRadius(12.dp)
                        .padding(horizontal = 10.dp, vertical = 5.dp)
                        .clickable(actionStartActivity(intent)),
                ) {
                    Text(label, style = TextStyle(color = colors.onSecondaryContainer, fontSize = 12.sp), maxLines = 1)
                }
            }
        }
    }

    private fun whyText(why: String?) = when (why) {
        "gap-home" -> "long gap"
        else -> null
    }
}

class RefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        Refresher.refresh(context)
    }
}

class NextBusWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NextBusWidget()

    override fun onEnabled(context: Context) {
        super.onEnabled(context)
        Refresher.schedule(context)
    }

    override fun onDisabled(context: Context) {
        super.onDisabled(context)
        Refresher.cancel(context)
    }
}
