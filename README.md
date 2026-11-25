# Moonvies

A personal movie and TV catalog for your home. Browse films and shows from TMDB with trailers, cast and
where to stream them, download what you're allowed to with **torlink**, then watch on your PC, your
phone or your TV, with subtitles, resume, next-episode and a phone remote.

It runs as one small Node server (no dependencies) on a PC or an always-on Linux box. Phones and the
TV open it over your home Wi-Fi or over Tailscale.

![Moonvies](icons/icon-512.png)

## What's in here

| Path | What it is |
|---|---|
| `server.mjs` | The server: catalog page, downloads (through torlink), streaming, subtitles, progress |
| `index.html` | The whole app (one page): browse, library, player, TV mode |
| `tv-pair.html` | The page a TV shows the first time, to pair with a 6-digit code |
| `tv-app/` | Android TV app (a full-screen wrapper that finds the server by itself) |
| `tv-home/` | Glass Home, an optional lightweight home screen for Android TV sticks |
| `tv-home-designs/` | The design study the home screen was picked from |

## Features

- Browse trending, popular, top rated and new titles; filter by genre, year and streaming country.
- Title pages with trailer, cast, ratings, where to watch, and a season and episode list for shows.
- Search torrent sources and download with one click; the best match is picked for episodes.
- The next episode downloads by itself while you watch (per show, can be turned off).
- Player: resume, skip intro and credits (from chapters), next-episode card, episode strip,
  audio language picker, subtitles (built-in, from files, or found on SubDL), subtitle size,
  background and timing, sleep timer, zoom, picture in picture, seek previews.
- Phones get MP4 copies made by ffmpeg (MKV plays everywhere this way); a player that can't show
  HEVC gets a 720p H.264 copy.
- Play on TV: send what you're watching to the TV app and use the phone as the remote.
- Disk view: free space, and watched downloads you can clear (they go to a bin first).
- Download guard: only films, episodes and their subtitles get through (see below).

## Download guard

Torrents sometimes hide a program next to the video (a "codec" `setup.exe`, a `.lnk` shortcut, a
`Movie.mkv.exe`). Moonvies never runs anything it downloads, and on top of that it checks every torrent:

1. As soon as torlink has a torrent's file list (before the data arrives), Moonvies reads it. If any
   file can run (`.exe`, `.msi`, `.bat`, `.cmd`, `.scr`, `.lnk`, `.vbs`, `.js`, `.ps1`, `.jar`, `.apk`,
   `.sh`, `.dll`, `.deb`, `.dmg` and similar, also with tricks like a trailing dot), or there's no video
   in it at all, the torrent is stopped and its files deleted. The Downloads drawer says which one and why.
2. When a download finishes, every file that isn't video, subtitles (`.srt`, `.ass`, `.ssa`, `.vtt`,
   `.sub`/`.idx`, `.sup`) or a harmless extra (cover images, `.nfo`, `.txt`) is deleted, so archives,
   disc images and web pages don't stay on the disk.

The lists are at the top of the guard section in `server.mjs` (`KEEP_EXT`, `RUNNABLE_EXT`).

## Step by step

### 1. Install the tools

You need **Node.js 22 or newer**, **ffmpeg** and **torlink**.

**Windows**

```powershell
winget install OpenJS.NodeJS.LTS
winget install Gyan.FFmpeg
npm install -g torlnk
```

**Linux (Fedora, Nobara, Ubuntu...)**

```bash
# Node: from your distribution, or nvm (https://github.com/nvm-sh/nvm)
nvm install 24
# ffmpeg: from your distribution, or a static build such as https://github.com/BtbN/FFmpeg-Builds/releases
# torlink:
npm install -g torlnk
```

If `npm install -g torlnk` fails on Linux with an `only-allow pnpm` error, use
`npm install -g --ignore-scripts torlnk`. It then works without WebRTC peers, which it doesn't need.

Check it worked: `torlnk --version`.

> **About torlink.** torlink is the download engine: Moonvies starts `torlnk serve` by itself and talks to
> it, so you never have to open torlink yourself. Close torlink's own window while Moonvies runs on
> Windows; both would manage the same downloads.

### 2. Get the code

```bash
git clone https://github.com/<you>/moonvies.git
cd moonvies
```

### 3. Get a TMDB key (the catalog)

TMDB provides every title, poster, trailer and cast list. The key is free.

1. Make an account at <https://www.themoviedb.org/signup>.
2. Open **Settings → API** (<https://www.themoviedb.org/settings/api>) and request a key; choose
   **Personal** / **Developer** and fill in the short form.
3. Copy either the **API Key** (a short code) or the **API Read Access Token** (a long one starting
   with `eyJ`). Both work.

You paste it into Moonvies the first time you open it (step 5). It's saved on the server in
`settings.json`, so every phone and the TV get it without asking again.

### 4. Get a SubDL key (subtitles, optional)

SubDL finds subtitles in any language when a download has none, or not yours.

1. Make an account at <https://subdl.com> and confirm your email (a new account's key is refused
   until you do).
2. Open <https://subdl.com/panel/api>, create a key and copy it.
3. In Moonvies, play any video, choose **＋ Find subtitles online…** in the subtitle menu, and paste
   the key when it asks. It's saved in `settings.json` too.

With the key in place, the same panel has **Get subtitles by themselves when a download finishes**:
tick it and pick up to four languages, in the order you prefer them.

### 5. Start it

**Just on this PC**

```bash
node server.mjs
```

It opens <http://localhost:5178>. Paste the TMDB key and you're in.

**For phones and the TV too**

```bash
node server.mjs --lan
```

On Windows you can double-click `start-phone.cmd` instead. The server prints a few links like this:

```
Moonvies running at http://localhost:5178/
  phone (Wi-Fi): http://192.168.1.20:5178/?t=4f3a...
  phone (Tailscale, works anywhere): http://my-pc:5178/?t=4f3a...
```

### 6. Log in from a phone

Moonvies has no accounts. Instead, the server makes one secret token (saved in `lan-token.txt`), and
the links above carry it as `?t=...`.

1. Open one of those links on the phone, once. It sets a cookie, and from then on the plain address
   (`http://192.168.1.20:5178`) works on that phone.
2. On iPhone, use **Share → Add to Home Screen** for an app icon; on Android, **Install app** in the
   browser menu.
3. Anyone with the link can use your catalog, so share it only with people in your home. To shut
   everyone out, delete `lan-token.txt` and restart: a new token is made and old links stop working.

The PC the server runs on never needs the token (`localhost` is always allowed).

**Away from home:** install [Tailscale](https://tailscale.com) on the server and the phone, sign both
into the same account, and use the Tailscale link. Nothing is opened to the internet.

### 7. Set up the TV

The TV app works on Android TV and Google TV (Xiaomi Mi TV Stick, Chromecast with Google TV, Shield...).

1. Build the app (Windows, needs the Android SDK command-line tools, build-tools 34 and platform 34,
   and a JDK):

   ```powershell
   powershell -File tv-app\build.ps1
   ```

   The first build makes a signing key in `tv-app/` (`signing.keystore` and `signing-password.txt`).
   **Keep both**: later versions must be signed with the same key to install over the old one.

2. Install it. Either over the network with adb (turn on **Developer options → USB debugging** on the
   TV first):

   ```powershell
   adb connect <tv-address>:5555
   adb install -r tv-app\movie-catalog-tv.apk
   ```

   or on the TV itself: install the **Downloader** app from the TV's store and open
   `http://<server-address>:5178/tv.apk`.

3. Open **Moonvies** on the TV. It searches the home network for the server by itself.
4. The first time, it shows a pairing screen. On your phone or PC, open **⬇ Downloads → 📺 TV app**
   and type the 6-digit code on the TV. Done: from now on the TV opens straight into the catalog.

The TV mode is made for the remote: arrows move, OK opens, Back closes. In the player, OK pauses, or
presses **Skip intro** / **Play next** when they're offered, and the time bar can be selected to seek
with previews.

**Play on TV from the phone:** while the TV app is open, a **📺 Play on TV** button appears in the
phone's player. It starts the video on the TV and turns the phone into the remote.

### 8. Run it all the time (Linux, optional)

A laptop or mini PC with a big drive makes a good always-on server. Example systemd user service,
`~/.config/systemd/user/moonvies.service`:

```ini
[Unit]
Description=Moonvies
After=network-online.target
StartLimitIntervalSec=0

[Service]
WorkingDirectory=%h/moonvies
Environment=TORLINK_STATE_DIR=%h/moonvies/torlink-state
Environment=CATALOG_DOWNLOAD_DIR=/mnt/media/Moonvies/Downloads
Environment=CATALOG_BIN_DIR=/mnt/media/Moonvies/Bin
Environment=FFMPEG_DIR=%h/tools/ffmpeg/bin
# with the films on an external drive: wait for it instead of filling the system disk
ExecStartPre=/usr/bin/mountpoint -q /mnt/media
ExecStart=/usr/bin/node server.mjs --lan --no-open
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now moonvies
loginctl enable-linger $USER   # keep it running after you log out and after a reboot
```

Mount the drive by UUID in `/etc/fstab` with `nofail` so a missing drive never blocks booting. To keep
phone copies and seek previews on the big drive too, make `phone` and `thumbs` in the app folder
symlinks to folders there.

Settings you can change with environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `5178` | The server's port |
| `CATALOG_DOWNLOAD_DIR` | `~/Downloads/torlink` | Where downloads go |
| `CATALOG_BIN_DIR` | `<downloads>/.catalog-bin` | Deleted downloads wait here 7 days (Linux) |
| `TORLINK_STATE_DIR` | torlink's own folder | torlink's queue and history |
| `TORLINK_API_PORT` | `9161` | Port of the torlink engine (local only) |
| `FFMPEG_DIR` | found on `PATH` | Folder with `ffmpeg` and `ffprobe` |

### 9. Glass Home (optional, Android TV)

`tv-home/` is a small, fast home screen for Android TV sticks: a Continue watching banner from
Moonvies (press it to resume the episode), a dock of favourite apps and all apps below. Hold OK on an
app to add it to the dock, move it or remove it.

```powershell
powershell -File tv-home\build.ps1
adb install -r tv-home\glass-home.apk
# tell it where Moonvies is (once):
adb shell am start -n com.oosozt.glasshome/.HomeActivity --es server http://<server-lan-ip>:5178 --es alt http://<server-tailscale-ip>:5178 --es token <contents of lan-token.txt>
# make it the Home screen:
adb shell cmd package set-home-activity com.oosozt.glasshome/.HomeActivity
```

If the TV's own launcher still wins, disable it with `adb shell pm disable-user --user 0
com.google.android.tvlauncher` (undo with `pm enable`). Don't use `pm uninstall-system-updates`: on
Android 9 it rolls back **every** system app, including the web engine and Google Play services.

## Files the server writes

All in the app folder, all ignored by git: `settings.json` (TMDB and SubDL keys, preferences),
`lan-token.txt` (the phone link token), `progress.json` (where you are in each video),
`favorites.json`, `downloads.json` (which title each download belongs to), `phone/` (phone copies)
and `thumbs/` (seek previews).

## Troubleshooting

- **"The torlink window is open"**: close torlink's own app (Windows); Moonvies runs its own engine.
- **A video plays sound but no picture on the TV**: the TV's web engine is too old for HEVC. Update
  **Android System WebView** in the Play Store; until then Moonvies converts such videos to H.264
  (a few minutes, once per video).
- **The TV app can't find the server**: the server must run with `--lan`, and the TV must be on the
  same Wi-Fi (or on Tailscale). Port 5178 must be allowed by the firewall.
- **Phone copies take space**: the Downloaded tab shows how much; clear them there, they're remade
  when needed.

## A note on downloads

Moonvies is a front end for a general-purpose torrent client. Only download what you have the right to
download in your country. The catalog data comes from TMDB; this product uses the TMDB API but is not
endorsed or certified by TMDB. Streaming availability is provided by JustWatch through TMDB.
