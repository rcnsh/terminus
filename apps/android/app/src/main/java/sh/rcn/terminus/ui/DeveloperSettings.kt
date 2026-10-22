package sh.rcn.terminus.ui

import android.content.ClipData
import android.content.ClipboardManager
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import sh.rcn.terminus.Diagnostics
import sh.rcn.terminus.L
import sh.rcn.terminus.R
import sh.rcn.terminus.RequestLog
import sh.rcn.terminus.Servers

/**
 * The developer menu, at the bottom of About: the server (only with more than one built in, so in a debug build with the dev stub), then
 * what the app is doing, to copy into a bug report, then its recent requests.
 */
@Composable
internal fun DeveloperGroups() {
    if (Servers.choices.size > 1) ServerGroup()
    DiagnosticsGroup()
    RequestsGroup()
}

/** Moving to or from the dev stub sets the sign-in aside, so the app starts again. */
@Composable
private fun ServerGroup() {
    val ctx = LocalContext.current
    var chosen by remember { mutableStateOf(Servers.base) }
    Group(stringResource(R.string.developer), stringResource(R.string.developer_server_hint)) {
        Servers.choices.forEachIndexed { i, base ->
            if (i > 0) RowDivider()
            val sub =
                when {
                    base.contains("10.0.2.2") -> stringResource(R.string.server_stub_emulator)
                    Servers.isLocal(base) -> stringResource(R.string.server_stub_reverse)
                    i == 0 -> stringResource(R.string.server_default)
                    else -> null
                }
            ServerRow(base.substringAfter("://"), sub, base == chosen) {
                if (base == chosen) return@ServerRow
                val restart = Servers.choose(ctx, base)
                chosen = base
                if (restart) ctx.restartApp()
            }
        }
    }
}

@Composable
private fun ServerRow(host: String, sub: String?, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth()
            .selectable(selected, role = Role.RadioButton, onClick = onClick)
            .heightIn(min = 52.dp)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(host, style = MaterialTheme.typography.bodyLarge)
            sub?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        RadioButton(selected = selected, onClick = null)
    }
}

/** A new session (the dev stub's, or the site's again): start from the top, as after signing in. */
private fun android.content.Context.restartApp() {
    val launch = packageManager.getLaunchIntentForPackage(packageName) ?: return
    startActivity(android.content.Intent.makeRestartActivityTask(launch.component))
    Runtime.getRuntime().exit(0)
}

/** Now, every second, so "ago" keeps up while the page is open. */
@Composable
private fun ticking(): Long {
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(1_000)
            now = System.currentTimeMillis()
        }
    }
    return now
}

/** The state alerts, push and the widgets depend on, each in a row; then Copy diagnostics. Read again after each request. */
@Composable
private fun DiagnosticsGroup() {
    val ctx = LocalContext.current
    val changes by RequestLog.changes.collectAsState()
    val now = ticking()
    // Off the main thread: the last answer is parsed, and the session read through the Keystore.
    val facts by produceState<Diagnostics.Facts?>(null, changes) { value = withContext(Dispatchers.IO) { Diagnostics.facts(ctx) } }
    val f = facts ?: return
    val allowed = stringResource(R.string.diag_allowed)
    val notAllowed = stringResource(R.string.diag_not_allowed)
    fun yes(b: Boolean?) = if (b == false) notAllowed else allowed
    Group(stringResource(R.string.diagnostics), stringResource(R.string.diagnostics_hint)) {
        ValueRow(stringResource(R.string.diag_server), f.server.substringAfter("://"))
        RowDivider()
        val clock = f.skewMs / 1000
        ValueRow(
            stringResource(R.string.diag_clock),
            when {
                clock == 0L -> stringResource(R.string.diag_clock_right)
                clock > 0 -> stringResource(R.string.diag_clock_behind, clock.toInt())
                else -> stringResource(R.string.diag_clock_ahead, (-clock).toInt())
            },
        )
        RowDivider()
        ValueRow(stringResource(R.string.diag_notifications), yes(f.notifications))
        RowDivider()
        ValueRow(stringResource(R.string.diag_exact), yes(f.exactAlarms))
        RowDivider()
        ValueRow(
            stringResource(R.string.diag_battery),
            stringResource(if (f.batteryUnrestricted == true) R.string.diag_unrestricted else R.string.diag_optimised),
        )
        RowDivider()
        ValueRow(
            stringResource(R.string.diag_push),
            stringResource(
                when {
                    !f.pushAvailable -> R.string.diag_push_unavailable
                    f.pushActive -> R.string.diag_push_active
                    else -> R.string.diag_push_inactive
                }
            ),
            sub =
                when {
                    !f.pushAvailable -> null
                    f.pushHeardAt <= 0 -> stringResource(R.string.diag_push_none)
                    else -> stringResource(R.string.diag_push_heard, ago(f.pushHeardAt, now))
                },
        )
        RowDivider()
        ValueRow(stringResource(R.string.diag_answer), ago(f.answerAt, now))
        RowDivider()
        ValueRow(
            stringResource(R.string.diag_refresh),
            if (f.refreshAlarmAt > now) localTime(f.refreshAlarmAt) else stringResource(R.string.diag_none),
        )
        RowDivider()
        ActionRow(
            stringResource(R.string.diag_copy),
            {
                val text = Diagnostics.report(f, RequestLog.entries(), System.currentTimeMillis())
                ctx.getSystemService(ClipboardManager::class.java)?.setPrimaryClip(ClipData.newPlainText("terminus diagnostics", text))
                // Android 13 and later show their own note of what was copied.
                if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) {
                    android.widget.Toast.makeText(ctx, L.s(R.string.diag_copied), android.widget.Toast.LENGTH_SHORT).show()
                }
            },
            sub = stringResource(R.string.diag_copy_sub),
        )
    }
}

/** The last requests to our server, newest first: what was asked, and how it went. */
@Composable
private fun RequestsGroup() {
    val changes by RequestLog.changes.collectAsState()
    val entries = remember(changes) { RequestLog.entries() }
    Group(stringResource(R.string.requests), stringResource(R.string.requests_hint)) {
        if (entries.isEmpty()) ValueRow(stringResource(R.string.requests_none), "")
        val noAnswer = stringResource(R.string.request_no_answer)
        entries.forEachIndexed { i, r ->
            if (i > 0) RowDivider()
            val outcome = r.status?.toString() ?: listOfNotNull(noAnswer, r.failure).joinToString(" · ")
            ValueRow(
                "${r.method} ${r.path}",
                outcome,
                sub = "${localTime(r.atMs)} · ${r.tookMs} ms · ${r.host}",
                warn = r.status == null || r.status >= 400,
            )
        }
    }
}

/** A row that does something at once (no page opens, so no ›): its name in the accent, and a line under it. */
@Composable
private fun ActionRow(title: String, onClick: () -> Unit, sub: String) {
    Column(
        Modifier.fillMaxWidth()
            .clickable(role = Role.Button, onClick = onClick)
            .heightIn(min = 52.dp)
            .padding(horizontal = 16.dp, vertical = 12.dp)
    ) {
        Text(title, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.primary)
        Hint(sub)
    }
}

/** A name (and a line under it), and its value on the right, in grey; [warn] in the error colour. */
@Composable
private fun ValueRow(label: String, value: String, sub: String? = null, warn: Boolean = false) {
    FieldRow(label, sub = sub) {
        Text(
            value,
            style = MaterialTheme.typography.bodyMedium,
            color = if (warn) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/** On screen, the phone's own time (the copied text has Singapore's). */
private fun localTime(ms: Long): String =
    java.time.format.DateTimeFormatter.ofPattern("HH:mm:ss")
        .format(java.time.Instant.ofEpochMilli(ms).atZone(java.time.ZoneId.systemDefault()))

/** "3 min ago", in the app's language; "Never" for no time. */
@Composable
private fun ago(at: Long, now: Long): String {
    if (at <= 0) return stringResource(R.string.diag_never)
    val s = ((now - at) / 1000).coerceAtLeast(0).toInt()
    return when {
        s < 60 -> stringResource(R.string.diag_s_ago, s)
        s < 3600 -> stringResource(R.string.diag_min_ago, s / 60)
        s < 48 * 3600 -> stringResource(R.string.diag_h_ago, s / 3600)
        else -> stringResource(R.string.diag_d_ago, s / 86_400)
    }
}
