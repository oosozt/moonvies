package com.moviecatalog.tv;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Moonvies for Android TV: a full-screen browser for the catalog running on the server.
 * It finds the server by itself: on the home network (asking every address for /api/tv/hello),
 * over Tailscale, or at its public address (Config.PUBLIC, set when the app is built). Then it
 * opens /tv, which pairs once with a code and from then on goes straight to the catalog.
 */
public class MainActivity extends Activity {
    static final int PORT = 5178;
    WebView web;
    FrameLayout root;
    View fullView;
    WebChromeClient.CustomViewCallback fullCallback;
    SharedPreferences prefs;
    final Handler ui = new Handler(Looper.getMainLooper());
    boolean searching, failedScreen, pageOk;
    String current; // the PC address in use

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("catalog", MODE_PRIVATE);
        root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(10, 5, 32));
        // lets the PC inspect the page over adb (only with developer options on the TV)
        WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(10, 5, 32));
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setUserAgentString(s.getUserAgentString() + " CatalogTV/1");
        CookieManager.getInstance().setAcceptCookie(true);
        web.addJavascriptInterface(new Bridge(), "CatalogTV");
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                if (!url.startsWith("http")) return;
                pageOk = true;
                shareCookie();
                CookieManager.getInstance().flush();
            }
            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                // The PC is off, or got a new address: look for it again.
                if (req.isForMainFrame() && !searching) { pageOk = false; findServer(true); }
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback cb) {
                fullView = view; fullCallback = cb;
                root.addView(view, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            @Override
            public void onHideCustomView() { leaveFull(); }
        });
        web.requestFocus();
        takePlay(getIntent());
        findServer(false);
    }

    /* The home screen can ask for an episode to start right away: extras play (download id), n (video), title. */
    String pendingPlay; // query to add to /tv until the page is up
    void takePlay(Intent it) {
        String id = it == null ? null : it.getStringExtra("play");
        if (id == null || !id.matches("[a-f0-9]{40}")) return;
        int n = it.getIntExtra("n", 0);
        String title = it.getStringExtra("title"); if (title == null) title = "";
        it.removeExtra("play");
        if (pageOk && current != null) {
            web.evaluateJavascript("window.tvOpen && tvOpen('" + id + "'," + n + "," + org.json.JSONObject.quote(title) + ")", null);
        } else {
            try { pendingPlay = "?play=" + id + "&n=" + n + "&title=" + java.net.URLEncoder.encode(title, "UTF-8"); } catch (Exception e) { pendingPlay = "?play=" + id + "&n=" + n; }
        }
    }

    @Override
    protected void onNewIntent(Intent it) {
        super.onNewIntent(it);
        setIntent(it);
        takePlay(it);
    }

    void leaveFull() {
        if (fullView == null) return;
        root.removeView(fullView); fullView = null;
        if (fullCallback != null) fullCallback.onCustomViewHidden();
        fullCallback = null;
    }

    /** Things the page can ask of the app. */
    class Bridge {
        @JavascriptInterface
        public void keepAwake(final boolean on) {
            // While a video plays, the TV must not dim or start its screensaver.
            ui.post(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }
        @JavascriptInterface
        public void forgetServer() { prefs.edit().remove("lan").remove("base").remove("alts").remove("last").apply(); }
    }

    void status(String title, String text) {
        String html = "<!doctype html><meta name=viewport content='width=device-width'><body style=\"margin:0;height:100vh;display:grid;place-items:center;"
            + "background:#0a0520;color:#dff8ff;font:18px/1.6 monospace;text-align:center\"><div style='max-width:80vw'>"
            + "<div style='font-size:30px;letter-spacing:.14em;color:#ff8ad1;text-shadow:0 0 16px #ff2e8899;margin-bottom:14px'>" + title + "</div>"
            + "<div style='color:#9d97cf'>" + text + "</div></div>";
        web.loadDataWithBaseURL("about:blank", html, "text/html", "utf-8", null);
    }

    static boolean isLan(String base) { return base.matches("http://(192\\.168\\.|10\\.|172\\.(1[6-9]|2\\d|3[01])\\.).*"); }

    List<String> alts() {
        List<String> out = new ArrayList<>();
        for (String a : prefs.getString("alts", "").split(" ")) if (a.startsWith("http")) out.add(a);
        return out;
    }

    /**
     * The address that worked last time first, then the server's home-network address (fastest),
     * its Tailscale addresses (this TV away from home, or the home address changed), a search of
     * the home network, and last the public address (a TV in someone else's home).
     */
    void findServer(final boolean again) {
        searching = true; failedScreen = false;
        status("MOONVIES", again ? "Lost the connection. Looking again…" : "Connecting…");
        new Thread(() -> {
            String lan = prefs.getString("lan", prefs.getString("base", null));
            String last = prefs.getString("last", null);
            String found = null, body = null;
            if (last != null && !last.equals(lan) && (body = helloBody(last, 4000)) != null) found = last;
            if (found == null && lan != null && (body = helloBody(lan, 1500)) != null) found = lan;
            if (found == null) for (String a : alts()) if ((body = helloBody(a, 3000)) != null) { found = a; break; }
            if (found == null && (found = scan()) != null) body = helloBody(found, 1500);
            if (found == null && !Config.PUBLIC.isEmpty() && (body = helloBody(Config.PUBLIC, 6000)) != null) found = Config.PUBLIC;
            if (found != null) prefs.edit().putString("last", found).apply();
            if (found != null && isLan(found)) {
                // remember the home address and the PC's Tailscale addresses it reports
                SharedPreferences.Editor ed = prefs.edit().putString("lan", found);
                List<String> alt = new ArrayList<>();
                Matcher m = Pattern.compile("\"(http://[0-9.]+:[0-9]+)\"").matcher(body == null ? "" : body);
                while (m.find()) alt.add(m.group(1));
                if (!alt.isEmpty()) ed.putString("alts", TextUtils.join(" ", alt));
                ed.apply();
            }
            final String go = found;
            ui.post(() -> {
                searching = false;
                if (go == null) {
                    failedScreen = true;
                    status("CAN'T REACH MOONVIES", "Check that this TV is connected to the internet.<br>"
                        + "If it still doesn't work, the Moonvies server may be off for a moment.<br><br>"
                        + "<b style='color:#3df2ff'>Press OK to try again.</b>");
                    return;
                }
                current = go;
                web.loadUrl(go + "/tv" + (pendingPlay != null ? pendingPlay : ""));
                pendingPlay = null;
            });
        }).start();
    }

    /**
     * The pairing cookie belongs to the address it was made on. Give it to the PC's other
     * addresses too, so the TV doesn't ask for a new code when it reaches the PC over Tailscale.
     */
    void shareCookie() {
        CookieManager cm = CookieManager.getInstance();
        String from = current, cookie = from == null ? null : cm.getCookie(from);
        if (cookie == null) return;
        Matcher m = Pattern.compile("(?:^|;\\s*)catalog=([a-f0-9]+)").matcher(cookie);
        if (!m.find()) return;
        List<String> all = alts();
        String lan = prefs.getString("lan", null);
        if (lan != null) all.add(lan);
        if (!Config.PUBLIC.isEmpty()) all.add(Config.PUBLIC);
        for (String to : all) if (!to.equals(from)) cm.setCookie(to, "catalog=" + m.group(1) + "; Max-Age=315360000; Path=/");
    }

    /** The reply of a Moonvies server at this address, or null. */
    static String helloBody(String base, int timeout) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(base + "/api/tv/hello").openConnection();
            c.setConnectTimeout(timeout); c.setReadTimeout(timeout);
            if (c.getResponseCode() != 200) return null;
            InputStream in = c.getInputStream();
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[512]; int n;
            while ((n = in.read(buf)) > 0 && out.size() < 4096) out.write(buf, 0, n);
            String body = out.toString("UTF-8");
            return body.contains("movie-catalog") ? body : null;
        } catch (Exception e) {
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static boolean hello(String base, int timeout) { return helloBody(base, timeout) != null; }

    /** Ask every address on this TV's own network(s), 64 at a time. */
    static String scan() {
        List<String> prefixes = new ArrayList<>();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (!(a instanceof Inet4Address) || !a.isSiteLocalAddress()) continue;
                    String ip = a.getHostAddress();
                    String p = ip.substring(0, ip.lastIndexOf('.') + 1);
                    if (!prefixes.contains(p)) prefixes.add(p);
                }
            }
        } catch (Exception ignored) { }
        final AtomicReference<String> hit = new AtomicReference<>();
        ExecutorService pool = Executors.newFixedThreadPool(64);
        for (String p : prefixes) {
            for (int i = 1; i < 255; i++) {
                final String base = "http://" + p + i + ":" + PORT;
                pool.execute(() -> { if (hit.get() == null && hello(base, 900)) hit.compareAndSet(null, base); });
            }
        }
        pool.shutdown();
        try { pool.awaitTermination(30, TimeUnit.SECONDS); } catch (InterruptedException ignored) { }
        return hit.get();
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        int k = e.getKeyCode();
        if (failedScreen && (k == KeyEvent.KEYCODE_DPAD_CENTER || k == KeyEvent.KEYCODE_ENTER)) {
            if (e.getAction() == KeyEvent.ACTION_UP) findServer(false);
            return true;
        }
        if (k == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() != KeyEvent.ACTION_UP) return true;
            if (fullView != null) { leaveFull(); return true; }
            if (!pageOk) { finish(); return true; }
            // The page closes its top window first; leave the app only when it has nothing to close.
            web.evaluateJavascript("window.tvBack ? window.tvBack() : false", (r) -> {
                if (!"true".equals(r)) finish();
            });
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    protected void onPause() {
        super.onPause();
        CookieManager.getInstance().flush();
        // stop playback when the TV goes home or to sleep (the page saves the position on hide)
        web.evaluateJavascript("document.querySelector('#pv')?.pause()", null);
    }
}
