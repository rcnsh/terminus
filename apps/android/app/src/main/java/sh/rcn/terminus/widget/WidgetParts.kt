package sh.rcn.terminus.widget

import android.graphics.Bitmap
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.cornerRadius
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.ContentScale
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
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
import androidx.glance.unit.ColorProvider
import sh.rcn.terminus.Ink
import sh.rcn.terminus.L
import sh.rcn.terminus.R

@Composable
internal fun SkyImage(bitmap: Bitmap, height: Dp) {
    Image(
        ImageProvider(bitmap),
        contentDescription = null,
        contentScale = ContentScale.FillBounds,
        modifier = GlanceModifier.fillMaxWidth().height(height),
    )
}

@Composable
internal fun Headline(face: Face, inks: Inks, size: TextUnit) {
    val base =
        when {
            face.dim -> inks.muted
            face.late -> inks.late
            else -> inks.ink
        }
    if (face.placeholder) {
        HeadlineBar(face.headline, inks, size)
        return
    }
    fun style(c: ColorProvider) = TextStyle(color = c, fontWeight = FontWeight.Bold, fontSize = size)
    val accent = face.big?.takeIf { !face.dim && !face.late }
    if (accent == null) {
        Text(face.headline, style = style(base), maxLines = headLines())
        return
    }
    val at = face.headline.indexOf(accent)
    Row(verticalAlignment = Alignment.Bottom) {
        face.headline.substring(0, at).takeIf { it.isNotEmpty() }?.let { Text(it, style = style(base), maxLines = 1) }
        Text(accent, style = style(inks.accent), maxLines = 1)
        face.headline.substring(at + accent.length).takeIf { it.isNotEmpty() }?.let { Text(it, style = style(base), maxLines = 1) }
    }
}

@Composable
internal fun HeadlineBar(said: String, inks: Inks, size: TextUnit, width: Dp = 150.dp) {
    Box(
        GlanceModifier.height((size.value * 1.25f).dp).semantics { contentDescription = said },
        contentAlignment = Alignment.CenterStart,
    ) {
        WidgetBar(width, (size.value * 0.72f).dp, inks)
    }
}

@Composable
internal fun WidgetBar(width: Dp, height: Dp, inks: Inks) {
    Box(GlanceModifier.width(width).height(height).cornerRadius(6.dp).background(inks.chip)) {}
}

private fun solid(argb: Long) = ColorProvider(Color(argb))

@Composable
internal fun Badge(svc: String, color: Long, paid: Boolean = false, big: Boolean = false) {
    Box(
        GlanceModifier.cornerRadius(if (big) 9.dp else 6.dp)
            .background(solid(color))
            .padding(horizontal = if (big) 8.dp else 6.dp, vertical = if (big) 4.dp else 1.dp),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            if (paid) "$svc $" else svc,
            style = TextStyle(color = solid(Ink.on(color)), fontWeight = FontWeight.Bold, fontSize = if (big) 16.sp else 12.sp),
            maxLines = 1,
        )
    }
}

@Composable
internal fun PillText(text: String, color: ColorProvider, inks: Inks) {
    Box(GlanceModifier.cornerRadius(10.dp).background(inks.chip).padding(horizontal = 8.dp, vertical = 2.dp)) {
        Text(text, style = TextStyle(color = color, fontSize = 11.sp, fontWeight = FontWeight.Medium), maxLines = 1)
    }
}

@Composable
internal fun PillOf(pill: Pill, inks: Inks) =
    PillText(if (pill.good) "● ${pill.text}" else pill.text, if (pill.good) inks.good else inks.muted, inks)

@Composable
internal fun Small(
    text: String,
    color: ColorProvider,
    size: TextUnit = 12.sp,
    lines: Int = 1,
    modifier: GlanceModifier = GlanceModifier,
    bold: Boolean = false,
) {
    Text(
        text,
        style = TextStyle(color = color, fontSize = size, fontWeight = if (bold) FontWeight.Medium else FontWeight.Normal),
        maxLines = lines,
        modifier = modifier,
    )
}

@Composable
internal fun SubLine(face: Face, inks: Inks) {
    if (face.sub == null && face.pill == null) return
    Row(GlanceModifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
        face.sub?.let { Small(it, inks.muted, 12.sp, modifier = GlanceModifier.defaultWeight()) }
        face.pill?.let {
            if (face.sub != null) Spacer(GlanceModifier.width(6.dp))
            PillOf(it, inks)
        }
    }
}

@Composable
internal fun LegRow(leg: Leg, inks: Inks, size: TextUnit = 13.sp) {
    Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        leg.svc?.let {
            Badge(it, leg.color, leg.paid)
            Spacer(GlanceModifier.width(7.dp))
        }
        Small(leg.text, inks.ink, size)
    }
}

@Composable
internal fun RefreshButton(action: Action, inks: Inks, side: Dp = 32.dp) {
    Box(
        GlanceModifier.size(side + 8.dp).semantics { contentDescription = L.s(R.string.refresh) }.clickable(action),
        contentAlignment = Alignment.Center,
    ) {
        Box(GlanceModifier.size(side).cornerRadius(side / 2).background(inks.chip), contentAlignment = Alignment.Center) {
            Image(
                ImageProvider(R.drawable.ic_refresh),
                contentDescription = null,
                colorFilter = ColorFilter.tint(inks.ink),
                modifier = GlanceModifier.size(side / 2),
            )
        }
    }
}

@Composable
internal fun ModeChips(chips: List<Mode>, showing: Mode, inks: Inks, action: (Mode) -> Action) {
    Row(GlanceModifier.fillMaxWidth()) {
        chips.forEachIndexed { i, m ->
            val on = m.id == showing.id
            Box(GlanceModifier.padding(start = if (i > 0) 6.dp else 0.dp)) {
                Box(
                    GlanceModifier.cornerRadius(18.dp)
                        .background(if (on) inks.chipOn else inks.chip)
                        .padding(horizontal = 14.dp, vertical = 9.dp)
                        .semantics {
                            contentDescription = if (on) L.s(R.string.mode_showing, m.label) else L.s(R.string.mode_show, m.label)
                        }
                        .clickable(action(m))
                ) {
                    Text(
                        m.label,
                        style =
                            TextStyle(
                                color = if (on) inks.onChipOn else inks.ink,
                                fontSize = 13.sp,
                                fontWeight = if (on) FontWeight.Medium else FontWeight.Normal,
                            ),
                        maxLines = 1,
                    )
                }
            }
        }
    }
}

@Composable
internal fun TileBox(tile: Tile, inks: Inks) {
    androidx.glance.layout.Column(GlanceModifier.cornerRadius(14.dp).background(inks.chip).padding(horizontal = 12.dp, vertical = 7.dp)) {
        Text(tile.label.uppercase(), style = TextStyle(color = inks.accent, fontSize = 11.sp, fontWeight = FontWeight.Bold), maxLines = 1)
        Text(
            listOfNotNull(tile.title, tile.where).joinToString(" · "),
            style = TextStyle(color = inks.ink, fontSize = 14.sp, fontWeight = FontWeight.Medium),
            maxLines = 1,
        )
    }
}
