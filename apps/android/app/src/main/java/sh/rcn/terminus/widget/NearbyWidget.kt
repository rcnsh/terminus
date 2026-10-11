package sh.rcn.terminus.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.action.actionStartActivity
import androidx.glance.appwidget.action.actionStartService
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Box
import androidx.glance.layout.fillMaxSize
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.PreferencesGlanceStateDefinition
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import org.json.JSONObject
import sh.rcn.terminus.Api
import sh.rcn.terminus.ApiError
import sh.rcn.terminus.L
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.R
import sh.rcn.terminus.Store
import sh.rcn.terminus.hour12
import sh.rcn.terminus.parseNearby
import sh.rcn.terminus.ui.MainActivity

/**
 * "Buses near you": the nearest stop's services at any size, from 2×1 up
 * ([NearbyFit]). Draws the board kept in [Store] ([NearbyShared]), which
 * every widget showing it shares.
 */
class NearbyWidget : GlanceAppWidget() {

    override val sizeMode = SizeMode.Exact

    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = Store(context)
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val boards = Latest<Long, Board>()
        provideContent {
            // Read again when redrawWidgets() bumps VERSION, as BaseWidget does.
            val version = currentState(VERSION) ?: 0L
            val board = boards.get(version) { Board(store) }
            val swap = currentState(NearbySwap.FROM)?.let { from ->
                NearbySwap.Swap(from, currentState(NearbySwap.TO) ?: "", currentState(NearbySwap.AT) ?: 0L)
            }
            Content(board, swap, currentState(NEARBY_PAGE) ?: 0, appWidgetId)
        }
    }

    /** The kept board, read once per redraw. */
    private class Board(store: Store) {
        val paired = store.paired
        val fetchedAt = store.nearbyFetchedAt.takeIf { it > 0L }
        val error = store.nearbyError
        val stops: List<NearbyStop>? = store.nearbyJson?.let { runCatching { parseNearby(JSONObject(it)) }.getOrNull() }
    }

    @Composable
    private fun Content(board: Board, swap: NearbySwap.Swap?, page: Int, appWidgetId: Int) {
        val ctx = LocalContext.current
        val size = LocalSize.current
        val look = WidgetLook.now(ctx)
        val now = System.currentTimeMillis()
        val view = NearbyView.of(board.paired, board.stops, swap, board.fetchedAt, board.error, page, now)
        val controls = NearbyControls(
            refresh = if (board.paired) nearbyRefresh(ctx, appWidgetId) else null,
            page = { PageAction.of(it) },
        )
        Box(
            modifier = GlanceModifier
                .fillMaxSize()
                .appWidgetBackground()
                .background(look.pageColor)
                .cornerRadius(android.R.dimen.system_app_widget_background_radius)
                .semantics { contentDescription = nearbySpoken(view.stops, board.fetchedAt, board.error) }
                .clickable(actionStartActivity(MainActivity.intentFor(ctx, nearby = true))),
        ) {
            NearbyLayout(look, size.width.value, size.height.value, view, controls)
        }
    }
}

class NearbyWidgetReceiver : BusWidgetReceiver(NearbyWidget())

/** ↻ on a Nearby widget: a fresh location fix where location is allowed, which a tap may start. */
internal fun nearbyRefresh(ctx: Context, appWidgetId: Int): Action =
    if (Locator.hasForeground(ctx)) actionStartService(WidgetModeService.nearbyIntent(ctx, appWidgetId), isForegroundService = true)
    else actionRunCallback<NearbyRefreshAction>()

/** ↻ without location permission: asks with none, and the widget says to turn it on. */
class NearbyRefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        NearbyShared.refresh(context, fresh = false, tapped = true)
    }
}

/**
 * The board of buses near you that the Nearby widgets and the big widget's
 * next buses share: fetched by a tap on ↻, by the Buses tab, and in the
 * background at most once a minute while a widget shows it. The background
 * has no location of its own (the app doesn't ask for "Allow all the time"),
 * so it asks only with a recent fix from the app, through the same cached
 * arrivals as everything else.
 */
internal object NearbyShared {
    private const val REFETCH_MS = 60_000L

    /** The board's widgets: every Nearby widget, and the others while one is big enough for its next buses. */
    suspend fun wanted(ctx: Context): Boolean {
        val mgr = GlanceAppWidgetManager(ctx)
        if (mgr.getGlanceIds(NearbyWidget::class.java).isNotEmpty()) return true
        return listOf(NextBusWidget::class.java, PlacesWidget::class.java).any { cls ->
            mgr.getGlanceIds(cls).any { WidgetModes.bigAnySize(ctx, it) }
        }
    }

    /** Whether a background fetch would ask for anything now: wanted, a minute since the last, and a fix to ask with. */
    suspend fun due(ctx: Context): Boolean {
        val store = Store(ctx)
        return store.paired && System.currentTimeMillis() - store.nearbyFetchedAt >= REFETCH_MS &&
            Locator.lastKnown(ctx) != null && wanted(ctx)
    }

    suspend fun refreshIfDue(ctx: Context) {
        if (due(ctx)) refresh(ctx, fresh = false, tapped = false)
    }

    /**
     * Fetches the board and redraws. [fresh]: a new location fix (only in
     * [WidgetModeService], which a tap started). [tapped]: says "Updating…"
     * meanwhile and what went wrong after; the background keeps quiet.
     */
    suspend fun refresh(ctx: Context, fresh: Boolean, tapped: Boolean) {
        val store = Store(ctx)
        val token = store.token ?: return
        if (tapped) {
            store.nearbyError = UPDATING
            redrawWidgets(ctx)
        }
        try {
            val loc = if (fresh) Locator.current(ctx) else Locator.lastKnown(ctx)
            val error = try {
                val json = Api(token, fast = tapped, hour12 = hour12(ctx)).nearbyJson(loc?.latitude, loc?.longitude, Locator.accOf(loc))
                store.saveNearby(json, System.currentTimeMillis(), sentWith = token)
                null
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: ApiError) {
                // The token refused: the phone signs out, and the widget says so.
                if (e.status == 401 && sh.rcn.terminus.Session.rejected(ctx, token)) return
                if (e.status == 400) L.s(R.string.turn_on_location) else e.message ?: L.s(R.string.couldnt_load)
            } catch (e: ParseError) {
                L.s(R.string.unexpected_answer)
            } catch (e: Exception) {
                L.s(R.string.offline)
            }
            if (tapped) store.nearbyError = error
        } finally {
            withContext(NonCancellable) {
                // Stopped before an answer: "Updating…" mustn't stay.
                if (store.nearbyError == UPDATING) store.nearbyError = null
                redrawWidgets(ctx)
                WidgetModes.armChosen(ctx)
            }
        }
    }

    /**
     * When the board's widgets next look different with nothing new, on the
     * phone's clock: a shown bus going ([NearbyBoard.GONE_MS] after it's
     * due), or the times turning old. Null with no board.
     */
    fun redrawAt(ctx: Context, now: Long): Long? {
        val store = Store(ctx)
        val at = store.nearbyFetchedAt.takeIf { it > 0L } ?: return null
        val stops = store.nearbyJson?.let { runCatching { parseNearby(JSONObject(it)) }.getOrNull() } ?: return null
        // The nearest two: a swap shows the twin, which is one of them.
        val buses = stops.take(2).flatMap { NearbyBoard.buses(it, at, now) }
        return listOfNotNull(at + WidgetModes.NEARBY_OLD_MS, NearbyBoard.redrawAt(buses, now)).filter { it > now }.minOrNull()
    }
}
