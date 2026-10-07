package sh.rcn.terminus.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import sh.rcn.terminus.R

/*
 * The parts every page of Settings is made of, as on the web
 * (settings-pages.js, account.css): a small grey heading in capitals, a card
 * of rows, a grey line under it. A row is a name, maybe a line under it, and
 * one control on the right. Two or three choices are pills; the main action
 * is a pill in the ink; red is only for deleting the account.
 */

/** A group's heading, its rows in one card, and at most one line under them. */
@Composable
internal fun Group(title: String?, hint: String? = null, content: @Composable ColumnScope.() -> Unit) {
    Column {
        title?.let { Label(it, Modifier.padding(start = 4.dp, bottom = 8.dp).semantics { heading() }) }
        Card(
            colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            modifier = Modifier.fillMaxWidth(),
        ) { Column(content = content) }
        hint?.let { Hint(it, Modifier.padding(start = 4.dp, end = 4.dp, top = 6.dp)) }
    }
}

/** Groups down a page, with room under the band. */
@Composable
internal fun Groups(content: @Composable ColumnScope.() -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(20.dp), modifier = Modifier.padding(top = 16.dp), content = content)
}

/** One setting: its name (and a line under it), then its control. */
@Composable
internal fun FieldRow(label: String, modifier: Modifier = Modifier, sub: String? = null, control: @Composable () -> Unit) {
    Row(modifier.fillMaxWidth().heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(label, style = MaterialTheme.typography.bodyLarge)
            sub?.let { Hint(it) }
        }
        Spacer(Modifier.width(12.dp))
        control()
    }
}

@Composable
internal fun RowDivider() = HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

/** Two or three choices as pills on one track, across the row. */
@Composable
internal fun <T> Pills(options: List<Pair<T, String>>, selected: T, onSelect: (T) -> Unit, modifier: Modifier = Modifier) {
    val c = MaterialTheme.colorScheme
    // The chosen pill a step lighter than the track: in the dark, the card's own colour would barely show.
    val chosen = if (c.background.luminance() < 0.5f) c.onSurface.copy(alpha = 0.14f).compositeOver(c.surface) else c.surface
    Row(
        modifier.fillMaxWidth().clip(CircleShape).background(c.surfaceContainerHighest).padding(3.dp).selectableGroup(),
    ) {
        for ((value, text) in options) {
            val on = value == selected
            Box(
                Modifier
                    .weight(1f)
                    .heightIn(min = 40.dp)
                    .then(if (on) Modifier.shadow(1.dp, CircleShape) else Modifier)
                    .clip(CircleShape)
                    .background(if (on) chosen else Color.Transparent)
                    .selectable(on, role = Role.RadioButton) { onSelect(value) },
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text,
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
                    color = if (on) c.onSurface else c.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 8.dp),
                )
            }
        }
    }
}

/** The page's main action: a pill in the ink, as the chosen chip on Now is. */
@Composable
internal fun InkButton(text: String, onClick: () -> Unit, modifier: Modifier = Modifier, enabled: Boolean = true) {
    val c = MaterialTheme.colorScheme
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier,
        colors = ButtonDefaults.buttonColors(
            containerColor = c.onSurface,
            contentColor = c.background,
            disabledContainerColor = c.onSurface.copy(alpha = 0.3f),
            disabledContentColor = c.background,
        ),
    ) { Text(text) }
}

/** The last row of a list: "+ Add …". */
@Composable
internal fun AddRow(text: String, onClick: () -> Unit) {
    val c = MaterialTheme.colorScheme
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(24.dp).background(c.surfaceContainerHighest, CircleShape), contentAlignment = Alignment.Center) {
            Text("+", style = MaterialTheme.typography.titleSmall, fontWeight = FontWeight.SemiBold)
        }
        Spacer(Modifier.width(12.dp))
        Text(text, style = MaterialTheme.typography.bodyLarge, fontWeight = FontWeight.Medium)
    }
}

/** Remove, quietly: grey, not the accent. */
@Composable
internal fun RemoveButton(onClick: () -> Unit, text: String? = null) {
    TextButton(onClick = onClick, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.onSurfaceVariant)) {
        Text(text ?: stringResource(R.string.remove))
    }
}

/** A row that opens something: in the app (›) or [away] in the browser (↗). [color] for Delete account. */
@Composable
internal fun LinkRow(title: String, onClick: () -> Unit, sub: String? = null, away: Boolean = false, color: Color = Color.Unspecified) {
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Row(
        Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onClick).heightIn(min = 52.dp).padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.bodyLarge, color = color)
            sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = muted, maxLines = 2, overflow = TextOverflow.Ellipsis) }
        }
        Icon(painterResource(if (away) R.drawable.ic_open else R.drawable.ic_chevron), contentDescription = null, tint = muted, modifier = Modifier.size(20.dp))
    }
}

/**
 * One choice from a long list (your residence, your stop): its name, then
 * what's chosen and a chevron, opening the list. `null` is the [blank]
 * option; [headings] go before the option at their index.
 */
@Composable
internal fun <T> ValueRow(
    label: String,
    options: List<Pair<T, String>>,
    selected: T?,
    onSelect: (T?) -> Unit,
    sub: String? = null,
    blank: String? = null,
    headings: Map<Int, String> = emptyMap(),
) {
    var open by rememberSaveable { mutableStateOf(false) }
    val shown = options.firstOrNull { it.first == selected }?.second ?: blank.orEmpty()
    val muted = MaterialTheme.colorScheme.onSurfaceVariant
    Box {
        Row(
            Modifier.fillMaxWidth().clickable(role = Role.DropdownList) { open = true }.heightIn(min = 52.dp).padding(start = 16.dp, end = 12.dp, top = 10.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.bodyLarge)
                sub?.let { Hint(it) }
            }
            Spacer(Modifier.width(12.dp))
            Text(shown, style = MaterialTheme.typography.bodyLarge, color = muted, maxLines = 2, overflow = TextOverflow.Ellipsis, textAlign = TextAlign.End, modifier = Modifier.widthIn(max = 200.dp))
            Icon(painterResource(R.drawable.ic_chevron), contentDescription = null, tint = muted, modifier = Modifier.padding(start = 4.dp).size(20.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }, modifier = Modifier.heightIn(max = 420.dp)) {
            if (blank != null) DropdownMenuItem(text = { Text(blank) }, onClick = { onSelect(null); open = false })
            for ((i, option) in options.withIndex()) {
                headings[i]?.let { Label(it, Modifier.padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 4.dp)) }
                val (value, text) = option
                DropdownMenuItem(text = { Text(text) }, onClick = { onSelect(value); open = false })
            }
        }
    }
}
