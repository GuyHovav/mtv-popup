package com.guyhovav.popupvideo;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class MainActivity extends BridgeActivity {
    // Must match capacitor.config.json's server.url.
    private static final String BASE_URL = "https://mtv-popup-client.vercel.app";
    private static final Pattern YOUTUBE_URL_PATTERN =
        Pattern.compile("https?://(?:www\\.)?(?:youtube\\.com/\\S+|youtu\\.be/\\S+)");

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleShareIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
    }

    // The YouTube app's share sheet always sends ACTION_SEND/text-plain with
    // the link embedded in free-form text (e.g. "Check this out: https://
    // youtu.be/abc123"), never a clean URL by itself — so the link has to be
    // pulled out of EXTRA_TEXT with a regex rather than used as-is.
    private void handleShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) return;
        if (!"text/plain".equals(intent.getType())) return;

        String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (sharedText == null) return;

        Matcher matcher = YOUTUBE_URL_PATTERN.matcher(sharedText);
        if (!matcher.find()) return;

        String targetUrl = BASE_URL + "/?url=" + Uri.encode(matcher.group());
        getBridge().getWebView().post(() -> getBridge().getWebView().loadUrl(targetUrl));
    }
}
