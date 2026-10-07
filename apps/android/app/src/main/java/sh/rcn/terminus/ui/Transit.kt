package sh.rcn.terminus.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import sh.rcn.terminus.R

/*
 * The pieces the screens borrow from NUS's own buses and stops: a stop's
 * sign (its name on a plate, the services under it), and a tile to choose
 * one thing from several. Drawn in the theme's colours, so they work in
 * light and dark; a service's colour is only ever that service's.
 */

/**
 * A stop's name plate, as on the pole: a shade off the card with a hairline
 * under it, the bus mark in the accent, the name, and anything to say about
 * it at the end (the walk there, a button), quieter. Not inverted: in the
 * dark a near-white plate glared off every stop.
 */
@Composable
internal fun StopPlate(name: String, modifier: Modifier = Modifier, big: Boolean = false, trailing: @Composable RowScope.() -> Unit = {}) {
    val c = MaterialTheme.colorScheme
    Row(
        modifier.fillMaxWidth().background(c.secondaryContainer).drawBehind {
            drawLine(c.outlineVariant, Offset(0f, size.height - 0.5f), Offset(size.width, size.height - 0.5f), 1.dp.toPx())
        }.padding(start = 14.dp, end = 8.dp).heightIn(min = if (big) 46.dp else 38.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Icon(painterResource(R.drawable.ic_bus), contentDescription = null, tint = c.primary, modifier = Modifier.size(if (big) 18.dp else 16.dp))
        Text(
            name,
            color = c.onSurface,
            fontWeight = FontWeight.Bold,
            fontSize = if (big) 17.sp else 15.sp,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f),
        )
        CompositionLocalProvider(LocalContentColor provides c.onSurfaceVariant) { trailing() }
    }
}

/** A stop's sign: the plate, then what's under it. Rounded, with a hairline round the lot. */
@Composable
internal fun StopSign(name: String, modifier: Modifier = Modifier, big: Boolean = false, trailing: @Composable RowScope.() -> Unit = {}, content: @Composable ColumnScope.() -> Unit) {
    val shape = RoundedCornerShape(if (big) 18.dp else 14.dp)
    Column(modifier.clip(shape).background(MaterialTheme.colorScheme.surface).border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)) {
        StopPlate(name, big = big, trailing = trailing)
        content()
    }
}

/** The services that call at a stop, as badges, in their own colours. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun ServiceBadges(services: List<String>, colors: Map<String, Long>, modifier: Modifier = Modifier) {
    FlowRow(modifier, horizontalArrangement = Arrangement.spacedBy(5.dp), verticalArrangement = Arrangement.spacedBy(5.dp)) {
        for (svc in services) BusBadge(svc, colors[svc] ?: 0xFF8A939C, 12.sp)
    }
}

/**
 * One choice of several, as a tile: outlined, or filled with the accent's
 * soft colour and edged in it when chosen, with a tick in the corner.
 */
@Composable
internal fun ChoiceTile(selected: Boolean, onClick: () -> Unit, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(16.dp)
    Box(
        modifier
            .heightIn(min = 64.dp)
            .clip(shape)
            .background(if (selected) c.primaryContainer else Color.Transparent)
            .border(if (selected) 2.dp else 1.dp, if (selected) c.primary else c.outlineVariant, shape)
            .selectable(selected, role = Role.RadioButton, onClick = onClick)
            .padding(horizontal = 13.dp, vertical = 11.dp),
    ) {
        Column(Modifier.padding(end = if (selected) 22.dp else 0.dp), content = content)
        if (selected) {
            Box(Modifier.align(Alignment.TopEnd).size(20.dp).background(c.primary, CircleShape), contentAlignment = Alignment.Center) {
                Icon(painterResource(R.drawable.ic_check), contentDescription = null, tint = c.onPrimary, modifier = Modifier.size(13.dp))
            }
        }
    }
}

/** A tile that opens something (Settings' pages), or just says something with no [onClick]. */
@Composable
internal fun LinkTile(onClick: (() -> Unit)?, modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    val c = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(18.dp)
    Column(
        modifier
            .clip(shape)
            .background(c.surface)
            .border(1.dp, c.outlineVariant, shape)
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(14.dp),
        content = content,
    )
}

/** Laid out two to a row, the last one alone if it's odd. */
@Composable
internal fun <T> TwoColumns(items: List<T>, modifier: Modifier = Modifier, gap: Dp = 8.dp, cell: @Composable (T, Modifier) -> Unit) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(gap)) {
        for (row in items.chunked(2)) {
            Row(Modifier.fillMaxWidth().height(IntrinsicSize.Min), horizontalArrangement = Arrangement.spacedBy(gap)) {
                for (item in row) cell(item, Modifier.weight(1f).fillMaxHeight())
                if (row.size == 1) Spacer(Modifier.weight(1f))
            }
        }
    }
}

/** A small heading over a group, in capitals: "YOUR STOPS". Said as written ("Your stops"), not spelt out as capitals. */
@Composable
internal fun Label(text: String, modifier: Modifier = Modifier, color: Color = MaterialTheme.colorScheme.onSurfaceVariant) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelMedium, fontWeight = FontWeight.Bold, letterSpacing = 0.8.sp, color = color, modifier = modifier.semantics { heading(); contentDescription = text })
}
