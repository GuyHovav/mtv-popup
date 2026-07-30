package com.guyhovav.popupvideo;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.widget.Toast;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.CapConfig;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    // Must match capacitor.config.json's server.url.
    private static final String BASE_URL = "https://mtv-popup-client.vercel.app";
    private static final Pattern YOUTUBE_URL_PATTERN =
        Pattern.compile("https?://(?:www\\.)?(?:youtube\\.com/\\S+|youtu\\.be/\\S+)");

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Must happen BEFORE super.onCreate(): that call synchronously loads
        // `config`'s server URL into the WebView, so overriding `config` here
        // (left null otherwise, which BridgeActivity treats as "use capacitor
        // .config.json's default") makes the very first navigation go
        // straight to the shared video. Calling loadUrl() a second time
        // *after* super.onCreate() instead was the previous approach, but it
        // raced Capacitor's own initial loadUrl() with no ordering guarantee.
        debugToast("onCreate intent: " + describeIntent(getIntent()));
        String sharedUrl = extractYoutubeUrl(getIntent());
        if (sharedUrl != null) {
            config = new CapConfig.Builder(this).setServerUrl(targetUrl(sharedUrl)).create();
            debugToast("Overriding start URL: " + targetUrl(sharedUrl));
        }
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        debugToast("onNewIntent: " + describeIntent(intent));
        // Covers the app already being open (singleTask launch mode reuses
        // the activity and delivers here instead of onCreate) — the bridge
        // and WebView already exist and are idle, so a direct loadUrl is
        // safe here, unlike the cold-start case handled above.
        String sharedUrl = extractYoutubeUrl(intent);
        if (sharedUrl != null) {
            getBridge().getWebView().loadUrl(targetUrl(sharedUrl));
        }
    }

    // Temporary on-device diagnostic — no adb/logcat needed to see what the
    // share intent actually looked like. Remove once share-to-app is
    // confirmed working reliably.
    private void debugToast(String message) {
        Toast.makeText(getApplicationContext(), message, Toast.LENGTH_LONG).show();
    }

    private static String describeIntent(Intent intent) {
        if (intent == null) return "null";
        String action = intent.getAction();
        String type = intent.getType();
        String extraText = intent.getStringExtra(Intent.EXTRA_TEXT);
        return "action=" + action + " type=" + type + " extraText=" + extraText;
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
