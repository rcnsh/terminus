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
import sh.rcn.terminus.LeaveAlerts
import sh.rcn.terminus.Locator
import sh.rcn.terminus.NearbyStop
import sh.rcn.terminus.ParseError
import sh.rcn.terminus.R
import sh.rcn.terminus.Store
import sh.rcn.terminus.hour12
import sh.rcn.terminus.parseNearby
import sh.rcn.terminus.ui.MainActivity

class NearbyWidget : GlanceAppWidget() {

    override val sizeMode = SizeMode.Exact

    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val store = Store(context)
        val appWidgetId = GlanceAppWidgetManager(context).getAppWidgetId(id)
        val boards = Latest<Long, Board>()
        provideContent {
            val version = currentState(VERSION) ?: 0L
            val board = boards.get(version) { Board(store) }
            val swap =
                currentState(NearbySwap.FROM)?.let { from ->
                    NearbySwap.Swap(from, currentState(NearbySwap.TO) ?: "", currentState(NearbySwap.AT) ?: 0L)
                }
            Content(board, swap, currentState(NEARBY_PAGE) ?: 0, appWidgetId)
        }
    }

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
        val controls =
            NearbyControls(
                refresh = if (board.paired) nearbyRefresh(ctx, appWidgetId) else null,
                page = { PageAction.of(it) },
            )
        Box(
            modifier =
                GlanceModifier.fillMaxSize()
                    .appWidgetBackground()
                    .background(look.pageColor)
                    .cornerRadius(android.R.dimen.system_app_widget_background_radius)
                    .semantics { contentDescription = nearbySpoken(ctx, view.stops, board.fetchedAt, board.error) }
                    .clickable(actionStartActivity(MainActivity.intentFor(ctx, nearby = true)))
        ) {
            NearbyLayout(look, size.width.value, size.height.value, view, controls)
        }
    }
}

class NearbyWidgetReceiver : BusWidgetReceiver(NearbyWidget())

internal fun nearbyRefresh(ctx: Context, appWidgetId: Int): Action =
    if (Locator.hasForeground(ctx)) actionStartService(WidgetModeService.nearbyIntent(ctx, appWidgetId), isForegroundService = true)
    else actionRunCallback<NearbyRefreshAction>()

class NearbyRefreshAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        NearbyShared.refresh(context, fresh = false, tapped = true)
    }
}

internal object NearbyShared {
    private const val REFETCH_MS = 60_000L

    suspend fun wanted(ctx: Context): Boolean {
        val mgr = GlanceAppWidgetManager(ctx)
        if (mgr.getGlanceIds(NearbyWidget::class.java).isNotEmpty()) return true
        return listOf(NextBusWidget::class.java, PlacesWidget::class.java).any { cls ->
            mgr.getGlanceIds(cls).any { WidgetModes.bigAnySize(ctx, it) }
        }
    }

    suspend fun due(ctx: Context, onRedraw: Boolean = false): Boolean {
        val store = Store(ctx)
        val now = System.currentTimeMillis()
        return store.paired &&
            now - store.nearbyFetchedAt >= REFETCH_MS &&
            (!onRedraw || now >= (refetchAt(store) ?: 0L)) &&
            Locator.lastKnown(ctx) != null &&
            wanted(ctx)
    }

    suspend fun refreshIfDue(ctx: Context, onRedraw: Boolean = false) {
        if (due(ctx, onRedraw)) refresh(ctx, fresh = false, tapped = false)
    }

    private fun board(store: Store): List<NearbyStop>? = store.nearbyJson?.let { runCatching { parseNearby(JSONObject(it)) }.getOrNull() }

    private fun refetchAt(store: Store): Long? {
        val at = store.nearbyFetchedAt.takeIf { it > 0L } ?: return null
        return NearbyBoard.boardRefetchAt(board(store) ?: return null, at, sh.rcn.terminus.ServerClock.skewMs)
    }

    suspend fun refresh(ctx: Context, fresh: Boolean, tapped: Boolean) {
        val store = Store(ctx)
        val token = store.token ?: return
        if (tapped) {
            store.nearbyError = UPDATING
            redrawWidgets(ctx)
        }
        try {
            val loc = if (fresh) Locator.current(ctx) else Locator.lastKnown(ctx)
            val error =
                try {
                    val json =
                        Api(token, fast = tapped, hour12 = hour12(ctx))
                            .nearbyJson(loc?.latitude, loc?.longitude, Locator.accOf(loc), stopped = true)
                    store.saveNearby(json, System.currentTimeMillis(), sentWith = token)
                    null
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (e: ApiError) {
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
                if (store.nearbyError == UPDATING) store.nearbyError = null
                redrawWidgets(ctx)
                WidgetModes.armChosen(ctx)
            }
        }
    }

    fun redrawAt(ctx: Context, now: Long): Long? {
        val store = Store(ctx)
        val at = store.nearbyFetchedAt.takeIf { it > 0L } ?: return null
        val stops = board(store) ?: return null
        return NearbyBoard.boardRedrawAt(stops, at, now, LeaveAlerts.canBeExact(ctx), sh.rcn.terminus.ServerClock.skewMs)
    }
}
