package sh.rcn.terminus

import android.app.Notification
import android.content.Context
import android.graphics.drawable.Icon
import android.os.Build

/**
 * On the bus (phase 6): the notification follows the ride. "On the D2 · off at
 * UTown 9:52", the next stop and how many are left, and a countdown to getting
 * off that the system ticks by itself.
 *
 * From Android 16 it's a progress bar too (Notification.ProgressStyle): one
 * segment per stop ridden, a point at each stop, and the bus's icon where the
 * clock puts it. The position is an estimate (stops evenly spaced between
 * boarding and the arrival, which is live when the server knows the bus's
 * plate), so it's redrawn at each stop by whoever posts the notification.
 */
object RideStyle {
    /** When the bus should reach its next stop, to redraw then; null once it's there. */
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
        // Each hop is 100 units long, so the bus can sit part-way between stops.
        val hops = ride.stops.size - 1
        val unit = 100
        val colour = ctx.getColor(R.color.icon_fg)
        return Notification.ProgressStyle()
            .setStyledByProgress(true)
            .setProgressTrackerIcon(Icon.createWithResource(ctx, R.drawable.ic_bus_tracker))
            .setProgressSegments(List(hops) { Notification.ProgressStyle.Segment(unit).setColor(colour) })
            // The stops in between: the first and last are the ends of the bar.
            .setProgressPoints((1 until hops).map { Notification.ProgressStyle.Point(it * unit).setColor(colour) })
            .setProgress((ride.progress(now) * hops * unit).toInt())
    }
}

/**
 * A countdown to [at] in the notification's header, which the system ticks
 * by itself; no time at all when there's nothing ahead to count down to.
 * [at] and [now] are on the server's clock; the header counts on the phone's.
 */
internal fun Notification.Builder.countdownTo(at: Long?, now: Long): Notification.Builder =
    if (at != null && at > now) setWhen(ServerClock.toDevice(at)).setShowWhen(true).setUsesChronometer(true).setChronometerCountDown(true)
    else setShowWhen(false)
