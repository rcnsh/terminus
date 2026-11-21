package sh.rcn.terminus

import android.app.Notification
import android.content.Context
import android.graphics.drawable.Icon
import android.os.Build

object RideStyle {
    fun nextRedrawAt(ride: Ride, now: Long): Long? {
        val hops = ride.stops.size - 1
        val next = ride.passed(now) + 1
        if (next > hops) return null
        return ride.boardMs + (ride.arriveMs - ride.boardMs) * next / hops
    }

    fun apply(ctx: Context, b: Notification.Builder, card: Card, ride: Ride, now: Long): Notification.Builder {
        b.setContentTitle(card.line ?: L.s(R.string.on_the, ride.svc)).setContentText(ride.nextText(now))
        b.countdownTo(ride.arriveMs, now)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.BAKLAVA) b.setStyle(progress(ctx, ride, now))
        return b
    }

    @androidx.annotation.RequiresApi(Build.VERSION_CODES.BAKLAVA)
    private fun progress(ctx: Context, ride: Ride, now: Long): Notification.ProgressStyle {
        val hops = ride.stops.size - 1
        val unit = 100
        val colour = ctx.getColor(R.color.icon_fg)
        return Notification.ProgressStyle()
            .setStyledByProgress(true)
            .setProgressTrackerIcon(Icon.createWithResource(ctx, R.drawable.ic_bus_tracker))
            .setProgressSegments(List(hops) { Notification.ProgressStyle.Segment(unit).setColor(colour) })
            .setProgressPoints((1 until hops).map { Notification.ProgressStyle.Point(it * unit).setColor(colour) })
            .setProgress((ride.progress(now) * hops * unit).toInt())
    }
}

internal fun Notification.Builder.countdownTo(at: Long?, now: Long): Notification.Builder =
    if (at != null && at > now) setWhen(ServerClock.toDevice(at)).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
    else setShowWhen(false)
