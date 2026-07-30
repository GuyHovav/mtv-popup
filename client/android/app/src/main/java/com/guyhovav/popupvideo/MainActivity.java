package com.guyhovav.popupvideo;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    // Must match capacitor.config.json's server.url.
    private static final String BASE_URL = "https://mtv-popup-client.vercel.app";
    private static final Pattern YOUTUBE_URL_PATTERN =
        Pattern.compile("https?://(?:www\\.)?(?:youtube\\.com/\\S+|youtu\\.be/\\S+)");

    // BridgeActivity.load() calls onNewIntent(getIntent()) itself at the end
    // of its own onCreate, so on a cold start onNewIntent runs while the
    // launch intent is still current. Without this guard it would fire a
    // second loadUrl for a page the CapConfig override below already opened —
    // a full extra page load, and therefore an extra /api/facts call.
    private boolean startupHandled = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must happen BEFORE super.onCreate(): that call synchronously loads
        // `config`'s server URL into the WebView, so overriding `config` here
        // (left null otherwise, which BridgeActivity treats as "use capacitor
        // .config.json's default") makes the very first navigation go
        // straight to the shared video, with no second navigation to race.
        String sharedUrl = extractYoutubeUrl(getIntent());
        if (sharedUrl != null) {
            config = new CapConfig.Builder(this).setServerUrl(targetUrl(sharedUrl)).create();
        }
        super.onCreate(savedInstanceState);
        startupHandled = true;
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        // Only the warm path: the app was already running (singleTask reuses
        // the activity), so the bridge and WebView exist and are idle and a
        // direct navigation is what's needed. The cold path is already
        // covered by the config override in onCreate.
        if (!startupHandled) return;

        String sharedUrl = extractYoutubeUrl(intent);
        if (sharedUrl != null) {
            getBridge().getWebView().loadUrl(targetUrl(sharedUrl));
        }
    }

    private static String targetUrl(String youtubeUrl) {
        return BASE_URL + "/?url=" + Uri.encode(youtubeUrl);
    }

    // The YouTube app's share sheet always sends ACTION_SEND/text-plain with
    // the link embedded in free-form text (e.g. "Check this out: https://
    // youtu.be/abc123"), never a clean URL by itself — so the link has to be
    // pulled out of EXTRA_TEXT with a regex rather than used as-is.
    private static String extractYoutubeUrl(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return null;
        String type = intent.getType();
        if (type == null || !type.startsWith("text/plain")) return null;

        String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (sharedText == null) return null;

        Matcher matcher = YOUTUBE_URL_PATTERN.matcher(sharedText);
        return matcher.find() ? matcher.group() : null;
    }
}
