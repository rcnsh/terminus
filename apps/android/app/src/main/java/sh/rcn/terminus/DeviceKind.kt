package sh.rcn.terminus

import android.content.Context
import android.content.pm.PackageManager
import androidx.annotation.StringRes

/**
 * What kind of device this is, for the words that name it: "this tablet" on a tablet, "this phone" otherwise. Decided once, from the device
 * rather than the window, so a phone that unfolds to a tablet's width (its hinge says so) stays a phone, as the iPhone Duo does.
 */
object DeviceKind {
    @Volatile private var tablet = false

    fun init(ctx: Context) {
        tablet =
            isTablet(
                ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_SENSOR_HINGE_ANGLE),
                ctx.resources.configuration.smallestScreenWidthDp,
            )
    }

    /** A tablet: 600 dp or more at its narrowest, and no hinge (a foldable phone is a phone, open or shut). */
    internal fun isTablet(hinge: Boolean, smallestWidthDp: Int) = !hinge && smallestWidthDp >= 600

    /** [id], or its "this tablet" version on a tablet. */
    @StringRes fun word(@StringRes id: Int): Int = if (tablet) TABLET[id] ?: id else id

    private val TABLET =
        mapOf(
            R.string.a11y_not_paired to R.string.a11y_not_paired_tablet,
            R.string.add_email_why to R.string.add_email_why_tablet,
            R.string.signs_in_itself to R.string.signs_in_itself_tablet,
            R.string.follow_device to R.string.follow_device_tablet,
            R.string.not_signed_in_hint to R.string.not_signed_in_hint_tablet,
            R.string.pair_phone_text to R.string.pair_phone_text_tablet,
            R.string.pair_phone_title to R.string.pair_phone_title_tablet,
            R.string.remove_this_phone to R.string.remove_this_phone_tablet,
            R.string.replace_with_phone to R.string.replace_with_phone_tablet,
            R.string.sign_out_title to R.string.sign_out_title_tablet,
            R.string.signed_out_key_lost to R.string.signed_out_key_lost_tablet,
            R.string.signed_out_removed to R.string.signed_out_removed_tablet,
            R.string.signed_out_unused to R.string.signed_out_unused_tablet,
            R.string.tap_to_pair to R.string.tap_to_pair_tablet,
            R.string.theme_hint to R.string.theme_hint_tablet,
            R.string.which_setup_text to R.string.which_setup_text_tablet,
            R.string.diagnostics_hint to R.string.diagnostics_hint_tablet,
            R.string.diag_push_unavailable to R.string.diag_push_unavailable_tablet,
            R.string.no_browser to R.string.no_browser_tablet,
            R.string.card_style_hint to R.string.card_style_hint_tablet,
            R.string.new_to_nus_hint to R.string.new_to_nus_hint_tablet,
            R.string.pair_title to R.string.pair_title_tablet,
            R.string.pair_scan to R.string.pair_scan_tablet,
            R.string.this_phone_tag to R.string.this_phone_tag_tablet,
            R.string.time_format_hint_auto to R.string.time_format_hint_auto_tablet,
        )
}
