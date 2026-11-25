package com.oosozt.glasshome;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Outline;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.text.TextUtils;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextClock;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Glass Home: the TV's home screen. Deep colour fields behind translucent panels, a big Continue
 * watching banner fed by Moonvies on the laptop, a dock of favourite apps and every app below.
 * Everything is laid out on a 1920x1080 design and scaled to the screen. The "glass" is a translucent
 * fill over a background drawn once, so nothing is blurred live (the stick has 1 GB of memory).
 */
public class HomeActivity extends Activity {
    static final String CATALOG = "com.moviecatalog.tv";
    static final String[] DEFAULT_DOCK = { CATALOG, "com.google.android.youtube.tv", "com.netflix.ninja",
        "com.amazon.amazonvideo.livingroom", "com.spotify.tv.android", "com.trt.tabii.android", "com.turkcell.ott", "com.wbd.stream" };
    static final int INK = Color.rgb(11, 13, 30), SOFT = Color.rgb(201, 205, 245), WHITE = Color.WHITE;

    float S; // screen pixels per design pixel
    Typeface light, regular, medium, semibold;
    SharedPreferences prefs;
    final Handler ui = new Handler(Looper.getMainLooper());
    PackageManager pm;

    ScrollView scroll;
    LinearLayout dockRow, gridBox;
    TextView greet, caption;
    FrameLayout hero;
    ImageView heroImg;
    TextView heroKick, heroTitle, heroPill;
    Intent heroIntent;
    String heroImageUrl;
    final Map<String, Bitmap> images = new HashMap<>();
    boolean firstFocusDone;

    int px(float v) { return Math.round(v * S); }

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("home", MODE_PRIVATE);
        pm = getPackageManager();
        takeConfig(getIntent());
        DisplayMetrics dm = getResources().getDisplayMetrics();
        S = Math.max(dm.widthPixels, dm.heightPixels) / 1920f;
        light = font(300); regular = font(400); medium = font(500); semibold = font(600);

        FrameLayout root = new FrameLayout(this);
        // the colour fields are soft, so a 384x216 picture stretched to the screen looks the same and costs 1/25 of the memory
        BitmapDrawable bg = new BitmapDrawable(getResources(), backdrop(384, 216));
        bg.setFilterBitmap(true);
        getWindow().setBackgroundDrawable(bg);
        scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setVerticalScrollBarEnabled(false);
        scroll.setClipChildren(false);
        scroll.setSmoothScrollingEnabled(false); // jump, don't glide
        root.addView(scroll, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout col = new LinearLayout(this);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(px(96), px(56), px(96), px(90));
        col.setClipChildren(false); col.setClipToPadding(false);
        scroll.addView(col, new FrameLayout.LayoutParams(-1, -2));

        col.addView(topBar());
        col.addView(hero(), lp(-1, px(430), px(44)));
        caption = text("", 24, medium, SOFT);
        caption.setPadding(px(10), 0, 0, 0);
        dockRow = new LinearLayout(this);
        dockRow.setClipChildren(false); dockRow.setClipToPadding(false);
        col.addView(dock(), lp(-1, -2, px(40)));
        col.addView(caption, lp(-1, -2, px(16)));
        TextView all = text("All apps", 30, semibold, WHITE);
        col.addView(all, lp(-1, -2, px(48)));
        gridBox = new LinearLayout(this);
        gridBox.setOrientation(LinearLayout.VERTICAL);
        gridBox.setClipChildren(false); gridBox.setClipToPadding(false);
        col.addView(gridBox, lp(-1, -2, px(22)));

        setContentView(root);
    }

    @Override
    protected void onNewIntent(Intent it) {
        super.onNewIntent(it);
        takeConfig(it);
        // Home pressed while already home: back to the top
        scroll.scrollTo(0, 0);
        hero.requestFocus();
    }

    /** One-time setup from adb: --es server http://... --es alt http://... --es token ... */
    void takeConfig(Intent it) {
        if (it == null) return;
        SharedPreferences.Editor ed = prefs.edit();
        boolean any = false;
        for (String k : new String[] { "server", "alt", "token" }) {
            String v = it.getStringExtra(k);
            if (v != null) { ed.putString(k, v.trim()); any = true; it.removeExtra(k); }
        }
        if (any) ed.apply();
    }

    boolean appsDirty = true;
    final android.content.BroadcastReceiver pkgWatch = new android.content.BroadcastReceiver() {
        @Override public void onReceive(android.content.Context c, Intent i) { appsDirty = true; if (hasWindowFocus()) buildApps(); }
    };

    @Override
    protected void onStart() {
        super.onStart();
        android.content.IntentFilter f = new android.content.IntentFilter();
        f.addAction(Intent.ACTION_PACKAGE_ADDED); f.addAction(Intent.ACTION_PACKAGE_REMOVED); f.addAction(Intent.ACTION_PACKAGE_CHANGED);
        f.addDataScheme("package");
        registerReceiver(pkgWatch, f);
    }

    @Override
    protected void onStop() {
        super.onStop();
        try { unregisterReceiver(pkgWatch); } catch (Exception ignored) { }
        appsDirty = true; // something may have changed while we weren't listening
    }

    @Override
    protected void onResume() {
        super.onResume();
        greet.setText(greeting());
        if (appsDirty) buildApps();
        loadContinue();
    }

    @Override
    public void onBackPressed() { /* this is home: nothing behind it */ }

    @Override
    public boolean onKeyDown(int code, KeyEvent e) {
        if (code == KeyEvent.KEYCODE_MENU) {
            View f = getCurrentFocus();
            if (f != null && f.getTag() instanceof String) { options((String) f.getTag()); return true; }
        }
        return super.onKeyDown(code, e);
    }

    /* ---------- look ---------- */

    Typeface font(int weight) {
        try {
            return new Typeface.Builder(getAssets(), "fonts/Outfit.ttf").setFontVariationSettings("'wght' " + weight).build();
        } catch (Exception e) {
            return Typeface.create("sans-serif", weight >= 600 ? Typeface.BOLD : Typeface.NORMAL);
        }
    }

    /** The colour fields, drawn once: blue top left, violet bottom right, teal at the top. */
    Bitmap backdrop(int w, int h) {
        Bitmap b = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(b);
        c.drawColor(INK);
        float d = (float) Math.hypot(w, h);
        blob(c, w * .18f, h * .22f, d * .36f, Color.rgb(59, 76, 255));
        blob(c, w * .82f, h * .70f, d * .38f, Color.rgb(193, 61, 255));
        blob(c, w * .60f, h * .10f, d * .28f, Color.rgb(0, 179, 164));
        return b;
    }

    void blob(Canvas c, float x, float y, float r, int color) {
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.DITHER_FLAG);
        p.setShader(new RadialGradient(x, y, r, new int[] { color, Color.argb(110, Color.red(color), Color.green(color), Color.blue(color)), Color.TRANSPARENT },
            new float[] { 0f, .45f, 1f }, Shader.TileMode.CLAMP));
        c.drawCircle(x, y, r, p);
    }

    GradientDrawable glass(int radius, int fill, int stroke) {
        GradientDrawable g = new GradientDrawable();
        g.setCornerRadius(px(radius));
        g.setColor(fill);
        if (stroke != 0) g.setStroke(Math.max(1, px(2)), stroke);
        return g;
    }

    TextView text(String s, float size, Typeface tf, int color) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, px(size));
        t.setTypeface(tf);
        t.setTextColor(color);
        t.setIncludeFontPadding(false);
        return t;
    }

    LinearLayout.LayoutParams lp(int w, int h, int top) {
        LinearLayout.LayoutParams l = new LinearLayout.LayoutParams(w, h);
        l.topMargin = top;
        return l;
    }

    void rounded(View v, final int radius) {
        v.setOutlineProvider(new ViewOutlineProvider() {
            @Override public void getOutline(View view, Outline o) { o.setRoundRect(0, 0, view.getWidth(), view.getHeight(), px(radius)); }
        });
        v.setClipToOutline(true);
    }

    String greeting() {
        int h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        String g = h < 5 ? "Good night" : h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
        return g + "\n" + new SimpleDateFormat("EEEE d MMMM", Locale.ENGLISH).format(Calendar.getInstance().getTime());
    }

    /* ---------- top bar ---------- */

    View topBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        greet = text(greeting(), 28, regular, SOFT);
        greet.setLineSpacing(px(8), 1f);
        bar.addView(greet, new LinearLayout.LayoutParams(0, -2, 1f));

        TextView gear = text("Settings", 24, medium, WHITE);
        gear.setGravity(Gravity.CENTER);
        gear.setPadding(px(30), 0, px(30), 0);
        gear.setBackground(glass(99, 0x22ffffff, 0x38ffffff));
        gear.setFocusable(true);
        gear.setOnClickListener(v -> launch(new Intent(Settings.ACTION_SETTINGS)));
        focusLook(gear, 99, false);
        LinearLayout.LayoutParams gl = new LinearLayout.LayoutParams(-2, px(64));
        gl.rightMargin = px(34);
        bar.addView(gear, gl);

        TextClock clock = new TextClock(this);
        clock.setFormat24Hour("HH:mm"); clock.setFormat12Hour("HH:mm");
        clock.setTextSize(android.util.TypedValue.COMPLEX_UNIT_PX, px(64));
        clock.setTypeface(light);
        clock.setTextColor(WHITE);
        clock.setIncludeFontPadding(false);
        bar.addView(clock);
        return bar;
    }

    /* ---------- Continue watching ---------- */

    View hero() {
        hero = new FrameLayout(this);
        hero.setFocusable(true);
        hero.setBackground(glass(36, 0x1affffff, 0x38ffffff));
        rounded(hero, 36);
        heroImg = new ImageView(this);
        heroImg.setScaleType(ImageView.ScaleType.CENTER_CROP);
        hero.addView(heroImg, new FrameLayout.LayoutParams(-1, -1));
        View shade = new View(this);
        GradientDrawable sg = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT, new int[] { 0xf20b0d1e, 0xb30b0d1e, 0x000b0d1e });
        shade.setBackground(sg);
        hero.addView(shade, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout t = new LinearLayout(this);
        t.setOrientation(LinearLayout.VERTICAL);
        heroKick = text("Moonvies", 26, regular, SOFT);
        heroTitle = text("Your films and shows", 76, semibold, WHITE);
        heroTitle.setMaxLines(1); heroTitle.setEllipsize(TextUtils.TruncateAt.END);
        heroTitle.setLetterSpacing(-.02f);
        heroPill = text("Open", 26, semibold, INK);
        heroPill.setPadding(px(34), px(16), px(34), px(16));
        heroPill.setBackground(glass(99, WHITE, 0));
        t.addView(heroKick);
        t.addView(heroTitle, lp(-2, -2, px(10)));
        LinearLayout.LayoutParams pl = lp(-2, -2, px(26));
        t.addView(heroPill, pl);
        FrameLayout.LayoutParams tl = new FrameLayout.LayoutParams(px(1100), -2, Gravity.BOTTOM | Gravity.START);
        tl.leftMargin = px(56); tl.bottomMargin = px(52);
        hero.addView(t, tl);

        // the focus ring sits on top
        final View ring = new View(this);
        ring.setBackground(glass(36, 0, 0));
        hero.addView(ring, new FrameLayout.LayoutParams(-1, -1));
        hero.setOnFocusChangeListener((v, has) -> {
            GradientDrawable g = glass(36, 0, 0);
            if (has) g.setStroke(px(5), WHITE);
            ring.setBackground(g);
            heroPill.setBackground(glass(99, has ? WHITE : 0xccffffff, 0));
            if (has) { scroll.scrollTo(0, 0); caption.setText("Opens in Moonvies"); }
        });
        hero.setOnClickListener(v -> launch(heroIntent != null ? heroIntent : appIntent(CATALOG)));
        return hero;
    }

    /** Finds what was being watched last on Moonvies (on the laptop) and shows it. */
    volatile boolean loading;
    final Map<String, String> backdrops = new HashMap<>(); // "type/id" -> picture address
    void loadContinue() {
        final String server = prefs.getString("server", null), alt = prefs.getString("alt", null), token = prefs.getString("token", null);
        if (server == null || token == null || loading) return;
        loading = true;
        new Thread(() -> { try { continueNow(server, alt, token); } finally { loading = false; } }).start();
    }

    void continueNow(String server, String alt, String token) {
        {
            try {
                String base = server, body = get(server + "/api/downloads", token);
                if (body == null && alt != null) { base = alt; body = get(alt + "/api/downloads", token); }
                if (body == null) return;
                JSONArray fin = new JSONObject(body).optJSONArray("finished");
                JSONObject best = null; String bestN = null; JSONObject bestW = null; long bestAt = 0;
                JSONObject newest = null;
                for (int i = 0; fin != null && i < fin.length(); i++) {
                    JSONObject f = fin.getJSONObject(i);
                    if (newest == null || f.optLong("completedAt") > newest.optLong("completedAt")) newest = f;
                    JSONObject w = f.optJSONObject("watch");
                    if (w == null) continue;
                    for (java.util.Iterator<String> it = w.keys(); it.hasNext(); ) {
                        String n = it.next(); JSONObject p = w.getJSONObject(n);
                        double t = p.optDouble("t", 0), d = p.optDouble("d", 0);
                        boolean inProgress = !p.optBoolean("w") && t > 30 && (d <= 0 || t < d - 60);
                        if (inProgress && p.optLong("at") > bestAt) { bestAt = p.optLong("at"); best = f; bestN = n; bestW = p; }
                    }
                }
                final String kick; final JSONObject pick; final int n; String left = null;
                if (best != null) {
                    pick = best; n = Integer.parseInt(bestN); kick = "Continue watching";
                    double d = bestW.optDouble("d", 0), t = bestW.optDouble("t", 0);
                    if (d > 0) { int m = (int) Math.max(1, Math.round((d - t) / 60)); left = m >= 60 ? (m / 60) + " h " + (m % 60) + " min left" : m + " min left"; }
                } else if (newest != null) { pick = newest; n = 0; kick = "New in your library"; }
                else return;
                JSONObject item = pick.optJSONObject("item");
                String title = pick.optString("title", "");
                if (title.isEmpty() && item != null) title = item.optString("title", "");
                if (title.isEmpty()) title = pick.optString("name", "Moonvies");
                title = title.replaceAll("\\s*\\((19|20)\\d\\d\\)\\s*$", ""); // "Overgeared (2026)" -> "Overgeared"
                String ep = "";
                if (!pick.isNull("season") && pick.has("season")) {
                    int s = pick.optInt("season"), e = pick.isNull("episode") ? -1 : pick.optInt("episode", -1);
                    if (e >= 0) ep = String.format(Locale.US, "S%02dE%02d", s, e);
                    else if (pick.optInt("vids", 1) > 1) ep = String.format(Locale.US, "S%02d · episode %d", s, n + 1);
                }
                final String shown = ep.isEmpty() ? title : title + " · " + ep;
                final String pill = best != null ? "▶  Resume" + (left != null ? "  ·  " + left : "") : "▶  Play";
                Intent go = appIntent(CATALOG);
                if (go != null) { go.putExtra("play", pick.getString("id")); go.putExtra("n", n); go.putExtra("title", shown); }
                final Intent goF = go;
                String ik = item == null ? null : item.optString("type") + "/" + item.optInt("id");
                String img = ik == null ? null : backdrops.get(ik);
                if (img == null && ik != null) { img = backdropUrl(base, token, item); if (img != null) backdrops.put(ik, img); }
                Bitmap bmp = img == null ? null : images.get(img);
                if (img != null && bmp == null) { images.clear(); bmp = getImage(img); if (bmp != null) images.put(img, bmp); } // keep one picture in memory
                final Bitmap bmpF = bmp; final String imgF = img;
                ui.post(() -> {
                    heroKick.setText(kick); heroTitle.setText(shown); heroPill.setText(pill); heroIntent = goF;
                    if (bmpF != null && !imgF.equals(heroImageUrl)) { heroImg.setImageBitmap(bmpF); heroImageUrl = imgF; }
                });
            } catch (Exception ignored) { }
        }
    }

    /** The title's wide picture from TMDB, with the key the catalog already has. */
    String backdropUrl(String base, String token, JSONObject item) {
        try {
            if (item == null) return null;
            String key = new JSONObject(get(base + "/api/settings", token)).optString("tmdbKey", "");
            if (key.isEmpty()) return null;
            String u = "https://api.themoviedb.org/3/" + item.getString("type") + "/" + item.getInt("id");
            boolean bearer = key.startsWith("eyJ");
            String body = get(bearer ? u : u + "?api_key=" + Uri.encode(key), bearer ? "Bearer " + key : null);
            JSONObject d = new JSONObject(body);
            String p = d.optString("backdrop_path", "");
            if (p.isEmpty() || "null".equals(p)) p = item.optString("poster_path", "");
            return p.isEmpty() || "null".equals(p) ? null : "https://image.tmdb.org/t/p/w780" + p;
        } catch (Exception e) { return null; }
    }

    /** GET with the catalog's cookie (auth starting "Bearer " goes in the Authorization header instead). */
    String get(String url, String auth) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(2500); c.setReadTimeout(6000);
            if (auth != null) {
                if (auth.startsWith("Bearer ")) c.setRequestProperty("Authorization", auth);
                else c.setRequestProperty("Cookie", "catalog=" + auth);
            }
            if (c.getResponseCode() != 200) return null;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[16384]; int r;
                while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
                return out.toString("UTF-8");
            }
        } catch (Exception e) { return null; }
    }

    Bitmap getImage(String url) {
        try {
            HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
            c.setConnectTimeout(3000); c.setReadTimeout(8000);
            try (InputStream in = c.getInputStream()) {
                BitmapFactory.Options o = new BitmapFactory.Options();
                o.inPreferredConfig = Bitmap.Config.RGB_565; // half the memory; a photo doesn't need more
                return BitmapFactory.decodeStream(in, null, o);
            }
        } catch (Exception e) { return null; }
    }

    /* ---------- apps ---------- */

    static class App { String pkg, label; Drawable banner, icon; }

    /** Every app the TV can open, keyed by package, in name order. */
    Map<String, App> apps() {
        Map<String, App> out = new LinkedHashMap<>();
        List<ResolveInfo> list = new ArrayList<>(pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LEANBACK_LAUNCHER), 0));
        list.addAll(pm.queryIntentActivities(new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0));
        for (ResolveInfo r : list) {
            String pkg = r.activityInfo.packageName;
            if (out.containsKey(pkg) || pkg.equals(getPackageName())) continue;
            App a = new App();
            a.pkg = pkg;
            a.label = String.valueOf(r.loadLabel(pm));
            try { a.banner = r.activityInfo.loadBanner(pm); } catch (Exception ignored) { }
            if (a.banner == null) try { a.banner = pm.getApplicationBanner(pkg); } catch (Exception ignored) { }
            a.icon = r.loadIcon(pm);
            out.put(pkg, a);
        }
        List<App> sorted = new ArrayList<>(out.values());
        Collections.sort(sorted, (x, y) -> x.label.compareToIgnoreCase(y.label));
        Map<String, App> res = new LinkedHashMap<>();
        for (App a : sorted) res.put(a.pkg, a);
        return res;
    }

    List<String> dockList() {
        String saved = prefs.getString("dock", null);
        List<String> l = new ArrayList<>();
        if (saved == null) Collections.addAll(l, DEFAULT_DOCK);
        else if (!saved.isEmpty()) Collections.addAll(l, saved.split(","));
        return l;
    }

    void saveDock(List<String> l) { prefs.edit().putString("dock", TextUtils.join(",", l)).apply(); }

    View dock() {
        FrameLayout panel = new FrameLayout(this);
        panel.setBackground(glass(40, 0x1cffffff, 0x30ffffff));
        // the dock's rounded pane clips its row; the padding leaves room for a focused tile to grow
        rounded(panel, 40);
        HorizontalScrollView hs = new HorizontalScrollView(this);
        hs.setHorizontalScrollBarEnabled(false);
        hs.setClipChildren(false); hs.setClipToPadding(false);
        hs.setPadding(px(24), px(24), px(24), px(24));
        hs.addView(dockRow);
        panel.addView(hs, new FrameLayout.LayoutParams(-1, -2));
        return panel;
    }

    String shownApps = "";

    void buildApps() {
        appsDirty = false;
        Map<String, App> all = apps();
        List<String> dock = dockList();
        StringBuilder key = new StringBuilder(TextUtils.join(",", dock)).append('|');
        for (String p : all.keySet()) key.append(p).append(',');
        if (key.toString().equals(shownApps)) return; // nothing changed since last time
        shownApps = key.toString();
        String focusedPkg = getCurrentFocus() != null && getCurrentFocus().getTag() instanceof String ? (String) getCurrentFocus().getTag() : null;

        dockRow.removeAllViews();
        int i = 0;
        for (String p : dock) {
            App a = all.get(p);
            if (a == null) continue;
            View t = tile(a, 249, 140);
            LinearLayout.LayoutParams l = new LinearLayout.LayoutParams(px(249), px(140));
            if (i++ > 0) l.leftMargin = px(22);
            dockRow.addView(t, l);
        }

        gridBox.removeAllViews();
        LinearLayout row = null; int c = 0;
        for (App a : all.values()) {
            if (c % 6 == 0) {
                row = new LinearLayout(this);
                row.setClipChildren(false); row.setClipToPadding(false);
                gridBox.addView(row, lp(-1, -2, c == 0 ? 0 : px(28)));
            }
            View t = tile(a, 262, 148);
            LinearLayout.LayoutParams l = new LinearLayout.LayoutParams(px(262), px(148));
            if (c % 6 > 0) l.leftMargin = px(31);
            row.addView(t, l);
            c++;
        }
        TextView settings = text("Settings", 30, medium, WHITE);
        // a last tile for the TV's settings
        settings.setGravity(Gravity.CENTER);
        settings.setFocusable(true);
        settings.setBackground(glass(26, 0x14ffffff, 0x22ffffff));
        settings.setOnClickListener(v -> launch(new Intent(Settings.ACTION_SETTINGS)));
        focusLook(settings, 26, true);
        if (c % 6 == 0) { row = new LinearLayout(this); gridBox.addView(row, lp(-1, -2, px(28))); }
        LinearLayout.LayoutParams sl = new LinearLayout.LayoutParams(px(262), px(148));
        if (c % 6 > 0) sl.leftMargin = px(31);
        row.addView(settings, sl);

        if (focusedPkg != null) {
            View again = dockRow.findViewWithTag(focusedPkg);
            if (again != null) again.requestFocus();
        } else if (!firstFocusDone) {
            firstFocusDone = true;
            hero.requestFocus();
        }
    }

    /** An app: its banner, or its icon and name on glass. Focus lifts it and puts a white ring round it. */
    View tile(final App a, int w, int h) {
        FrameLayout t = new FrameLayout(this);
        t.setTag(a.pkg);
        t.setFocusable(true);
        t.setBackground(glass(26, 0x14ffffff, 0x22ffffff));
        rounded(t, 26);
        if (a.banner != null) {
            ImageView iv = new ImageView(this);
            iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
            iv.setImageDrawable(a.banner);
            t.addView(iv, new FrameLayout.LayoutParams(-1, -1));
        } else {
            LinearLayout in = new LinearLayout(this);
            in.setOrientation(LinearLayout.VERTICAL);
            in.setGravity(Gravity.CENTER);
            ImageView iv = new ImageView(this);
            iv.setImageDrawable(a.icon);
            in.addView(iv, new LinearLayout.LayoutParams(px(64), px(64)));
            TextView tv = text(a.label, 24, medium, 0xffe5e8ff);
            tv.setGravity(Gravity.CENTER);
            tv.setMaxLines(1); tv.setEllipsize(TextUtils.TruncateAt.END);
            tv.setPadding(px(12), 0, px(12), 0);
            in.addView(tv, lp(-1, -2, px(12)));
            t.addView(in, new FrameLayout.LayoutParams(-1, -1));
        }
        final View ring = new View(this);
        t.addView(ring, new FrameLayout.LayoutParams(-1, -1));
        t.setOnFocusChangeListener((v, has) -> {
            GradientDrawable g = glass(26, 0, 0);
            if (has) g.setStroke(px(5), WHITE);
            ring.setBackground(has ? g : null);
            if (has) caption.setText(a.label + "     ·     hold OK for options");
        });
        t.setOnClickListener(v -> launch(appIntent(a.pkg)));
        t.setOnLongClickListener(v -> { options(a.pkg); return true; });
        return t;
    }

    void focusLook(final View v, final int radius, final boolean grow) {
        final Drawable normal = v.getBackground();
        v.setOnFocusChangeListener((x, has) -> {
            v.setBackground(has ? glass(radius, WHITE, 0) : normal);
            if (v instanceof TextView) ((TextView) v).setTextColor(has ? INK : WHITE);
            if (has && grow) caption.setText("TV settings");
        });
    }

    /** Hold OK (or Menu) on an app: dock it, move it, or open its info page. */
    void options(final String pkg) {
        final List<String> dock = dockList();
        final int at = dock.indexOf(pkg);
        final List<String> labels = new ArrayList<>(); final List<Runnable> acts = new ArrayList<>();
        if (at < 0) { labels.add("Add to the dock"); acts.add(() -> { dock.add(pkg); saveDock(dock); }); }
        else {
            if (at > 0) { labels.add("Move left"); acts.add(() -> { Collections.swap(dock, at, at - 1); saveDock(dock); }); }
            if (at < dock.size() - 1) { labels.add("Move right"); acts.add(() -> { Collections.swap(dock, at, at + 1); saveDock(dock); }); }
            labels.add("Remove from the dock"); acts.add(() -> { dock.remove(pkg); saveDock(dock); });
        }
        labels.add("App info"); acts.add(() -> launch(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + pkg))));
        new AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(label(pkg))
            .setItems(labels.toArray(new String[0]), (d, which) -> { acts.get(which).run(); shownApps = ""; buildApps(); refocus(pkg); })
            .show();
    }

    void refocus(final String pkg) {
        ui.post(() -> { View v = dockRow.findViewWithTag(pkg); if (v == null) v = gridBox.findViewWithTag(pkg); if (v != null) v.requestFocus(); });
    }

    String label(String pkg) {
        try { ApplicationInfo ai = pm.getApplicationInfo(pkg, 0); return String.valueOf(pm.getApplicationLabel(ai)); } catch (Exception e) { return pkg; }
    }

    Intent appIntent(String pkg) {
        Intent i = pm.getLeanbackLaunchIntentForPackage(pkg);
        if (i == null) i = pm.getLaunchIntentForPackage(pkg);
        return i;
    }

    void launch(Intent i) {
        if (i == null) return;
        try { startActivity(i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); }
        catch (ActivityNotFoundException | SecurityException e) { caption.setText("That app can't be opened."); }
    }
}
