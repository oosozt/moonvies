# Builds glass-home.apk (the TV's home screen) without Gradle: aapt2 -> javac -> d8 -> zipalign -> apksigner.
# Same toolchain as ..\tv-app\build.ps1, and signed with that app's key. Run: powershell -File tv-home\build.ps1
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { "$env:LOCALAPPDATA\Android\Sdk" }
$bt = "$sdk\build-tools\34.0.0"
$jar = "$sdk\platforms\android-34\android.jar"
$out = "$here\build"
$version = 4   # raise for each new release so it installs over the old one

if (Test-Path $out) { Remove-Item -Recurse -Force $out }
New-Item -ItemType Directory -Force "$out\classes", "$out\dex" | Out-Null

python "$here\make_art.py"
if ($LASTEXITCODE) { throw 'art failed' }

& "$bt\aapt2.exe" compile --dir "$here\res" -o "$out\res.zip"
if ($LASTEXITCODE) { throw 'aapt2 compile failed' }
& "$bt\aapt2.exe" link -o "$out\base.apk" -I $jar --manifest "$here\AndroidManifest.xml" -A "$here\assets" "$out\res.zip" `
    --min-sdk-version 26 --target-sdk-version 34 --version-code $version --version-name "1.$version"
if ($LASTEXITCODE) { throw 'aapt2 link failed' }

$src = Get-ChildItem -Recurse "$here\src" -Filter *.java | ForEach-Object FullName
& javac -nowarn -source 11 -target 11 -encoding UTF-8 -classpath $jar -d "$out\classes" $src
if ($LASTEXITCODE) { throw 'javac failed' }
$classes = Get-ChildItem -Recurse "$out\classes" -Filter *.class | ForEach-Object FullName
& "$sdk\cmdline-tools\latest\bin\d8.bat" --release --min-api 26 --lib $jar --output "$out\dex" $classes
if ($LASTEXITCODE) { throw 'd8 failed' }

python -c "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'a',zipfile.ZIP_DEFLATED); z.write(sys.argv[2],'classes.dex'); z.close()" "$out\base.apk" "$out\dex\classes.dex"
& "$bt\zipalign.exe" -p -f 4 "$out\base.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'zipalign failed' }

$ks = "$here\..\tv-app\signing.keystore"; $pw = (Get-Content -Raw "$here\..\tv-app\signing-password.txt").Trim()
& "$bt\apksigner.bat" sign --ks $ks --ks-pass "pass:$pw" --ks-key-alias tv --out "$here\glass-home.apk" "$out\aligned.apk"
if ($LASTEXITCODE) { throw 'apksigner failed' }
& "$bt\apksigner.bat" verify "$here\glass-home.apk"
if ($LASTEXITCODE) { throw 'verify failed' }
Write-Host "Built $here\glass-home.apk"
