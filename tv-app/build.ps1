# Builds movie-catalog-tv.apk without Gradle: aapt2 (resources) -> javac -> d8 (dex) -> zipalign -> apksigner.
# Needs the JDK and Android SDK build-tools 34 + platform 34. Run: powershell -File tv-app\build.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$bt = "$sdk\build-tools\34.0.0"
$jar = "$sdk\platforms\android-34\android.jar"
$out = "$here\build"
$version = 5   # raise for each new release so it installs over the old one

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force "$out\classes", "$out\dex" | Out-Null

python "$here\make_art.py"
if ($LASTEXITCODE) { throw 'art failed' }

& "$bt\aapt2.exe" compile --dir "$here\res" -o "$out\res.zip"
if ($LASTEXITCODE) { throw 'aapt2 compile failed' }
& "$bt\aapt2.exe" link -o "$out\base.apk" -I $jar --manifest "$here\AndroidManifest.xml" "$out\res.zip" `
    --min-sdk-version 21 --target-sdk-version 34 --version-code $version --version-name "1.$version"
if ($LASTEXITCODE) { throw 'aapt2 link failed' }

# The server's public address (like https://moonvies.example.com), from public-url.txt next to this
# script, which stays out of git. Without it the app only finds the server at home and over Tailscale.
$public = if (Test-Path "$here\public-url.txt") { (Get-Content "$here\public-url.txt" -Raw).Trim().TrimEnd('/') } else { '' }
if ($public -and $public -notmatch '^https://[a-z0-9.-]+$') { throw "public-url.txt should hold just an address like https://moonvies.example.com" }
New-Item -ItemType Directory -Force "$out\gen\com\moviecatalog\tv" | Out-Null
Set-Content -Encoding ascii "$out\gen\com\moviecatalog\tv\Config.java" "package com.moviecatalog.tv;`n/** Made by build.ps1. */`nfinal class Config { static final String PUBLIC = `"$public`"; }"
Write-Host "Public address: $(if ($public) { $public } else { '(none)' })"
$src = Get-ChildItem -Recurse "$here\src" -Filter *.java | ForEach-Object FullName
$src = @($src) + "$out\gen\com\moviecatalog\tv\Config.java"
& javac -nowarn -source 11 -target 11 -encoding UTF-8 -classpath $jar -d "$out\classes" $src
if ($LASTEXITCODE) { throw 'javac failed' }
$classes = Get-ChildItem -Recurse "$out\classes" -Filter *.class | ForEach-Object FullName
# the newer d8 from cmdline-tools: build-tools 34's d8 crashes on class files from JDK 21
& "$sdk\cmdline-tools\latest\bin\d8.bat" --release --min-api 21 --lib $jar --output "$out\dex" $classes
if ($LASTEXITCODE) { throw 'd8 failed' }

# add classes.dex to the apk
python -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'a',zipfile.ZIP_DEFLATED); z.write(sys.argv[2],'classes.dex'); z.close()" "$out\base.apk" "$out\dex\classes.dex"
& "$bt\zipalign.exe" -p -f 4 "$out\base.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'zipalign failed' }

# The signing key stays in this folder: updates must be signed with the same key to install over the old app.
$ks = "$here\signing.keystore"; $pwFile = "$here\signing-password.txt"
if (-not (Test-Path $ks)) {
    $pw = -join ((48..57) + (97..122) | Get-Random -Count 24 | ForEach-Object { [char]$_ })
    Set-Content -NoNewline -Encoding ascii $pwFile $pw
    & keytool -genkeypair -keystore $ks -storepass $pw -keypass $pw -alias tv -keyalg RSA -keysize 2048 -validity 20000 -dname "CN=Movie Catalog TV" | Out-Null
    if ($LASTEXITCODE) { throw 'keytool failed' }
}
$pw = (Get-Content -Raw $pwFile).Trim()
& "$bt\apksigner.bat" sign --ks $ks --ks-pass "pass:$pw" --ks-key-alias tv --out "$here\movie-catalog-tv.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'apksigner failed' }
& "$bt\apksigner.bat" verify "$here\movie-catalog-tv.apk"
if ($LASTEXITCODE) { throw 'verify failed' }
Write-Host "Built $here\movie-catalog-tv.apk"
