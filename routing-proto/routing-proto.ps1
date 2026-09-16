<#
  SofiaMap -- routing engine prototype (OTP2 vs Motis) on real Sofia data.

  Why this script exists:
  Claude's cloud sandbox cannot download the Sofia Traffic GTFS feed, the
  OTP2 jar (Maven Central) or the Motis binary (GitHub release-asset
  downloads are blocked by the sandbox's egress policy). Your machine
  (lx15pro) has normal internet, so this script runs here instead. It does
  not touch the existing site code/DB at all -- everything lives under
  C:\SofiaMap\routing-proto\, safe to delete entirely at any time.

  NOTE ON ENCODING: this file is intentionally plain ASCII (no Cyrillic) to
  avoid a Windows PowerShell 5.1 issue where UTF-8 script files without a
  BOM get misdecoded, which can corrupt string/quote parsing and crash the
  whole script with confusing syntax errors far from the real problem.

  What it does:
    1. Checks Java (needed for OTP2) and free disk space.
    2. Downloads the Sofia Traffic static GTFS feed (bus/tram/trolleybus AND
       metro -- confirmed present: routes.txt has 4 metro lines, M1-M4,
       route_type=1, published by the same single agency as everything else).
    3. Builds the graph and starts an OpenTripPlanner 2 server (port 8080).
    4. Downloads and starts Motis (port 8081).
    5. Writes logs and measures build/import time + process memory.

  How to run:
    Open PowerShell IN THIS FOLDER (or pass the full script path) and run:
        powershell -ExecutionPolicy Bypass -File .\routing-proto.ps1
    The script prints progress for every step. If one step fails, later
    independent steps still try to run -- a summary at the end shows what
    worked and what did not.

  What to do after it runs (manually, in a browser):
    - OTP2: open http://localhost:8080 -- a debug client with a map; try
      building a route by hand (e.g. "NDK" -> "Sofia Airport", or something
      with a transfer -- "Studentski grad" -> "Lyulin"). Cyrillic names
      should work fine when typed in the browser itself.
    - Motis: open http://localhost:8081 (or whatever port motis.exe prints
      if it picked a different one) -- its own web client, same test
      routes.
    Both engines geocode addresses/stop names themselves -- no need to look
    up coordinates.

  What to send back to Claude once both servers are up (or have failed):
    - The full contents of routing-proto\logs\*.log
    - Output of this command (run AFTER both servers are up in their own
      windows -- this script opens them separately so they do not block
      each other):
        Get-Process java,motis -ErrorAction SilentlyContinue |
          Select-Object ProcessName, Id, @{N='RAM_MB';E={[math]::Round($_.WorkingSet64/1MB)}}
    - A couple of screenshots of a computed route in both UIs, if it worked.
    - If step 3 or 4 failed with a Java version error or an unrecognized
      Motis command-line flag -- just paste the error text back, and the
      script will get adjusted to match exactly what is installed.
#>

param(
  [string]$WorkDir = "C:\SofiaMap\routing-proto",
  [string]$OsmPbf = "C:\SofiaMap\raw\sofia.osm.pbf",
  [string]$OtpVersion = "2.7.0",       # known to work with Java 21; if you have Java 25, try bumping to 2.9.0
  [int]$OtpPort = 8080,
  [int]$MotisPort = 8081,
  [string]$OtpMemory = "4G"
)

$ErrorActionPreference = "Continue"
$logDir = Join-Path $WorkDir "logs"
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-Step($msg) {
  Write-Host ""
  Write-Host "=== $msg ===" -ForegroundColor Cyan
}

function Write-Result($ok, $msg) {
  if ($ok) { Write-Host "[OK] $msg" -ForegroundColor Green }
  else { Write-Host "[FAIL] $msg" -ForegroundColor Red }
}

# Used to avoid starting a second OTP2/Motis server instance when one from an
# earlier run of this script is still up -- re-running used to crash with a
# "log file is used by another process" error because the old server was
# still holding its own log file open while a new instance tried to write to
# the same path.
function Test-PortOpen([int]$port) {
  try {
    $client = New-Object System.Net.Sockets.TcpClient
    $iar = $client.BeginConnect("127.0.0.1", $port, $null, $null)
    $ok = $iar.AsyncWaitHandle.WaitOne(500) -and $client.Connected
    $client.Close()
    return [bool]$ok
  } catch {
    return $false
  }
}

$summary = @{}

# ---------------------------------------------------------------------------
Write-Step "1. Environment check"
# ---------------------------------------------------------------------------

# Resolve a usable java.exe without requiring it on PATH: try PATH first,
# then common install locations, then a portable JDK downloaded earlier by
# this same script, and only download a fresh portable JDK (Eclipse
# Temurin 21, a plain zip -- no installer, no system changes, no admin
# rights needed) as a last resort. Returns $null if nothing worked.
function Resolve-JavaExe {
  $cmd = Get-Command java -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }

  $commonPatterns = @(
    "C:\Program Files\Eclipse Adoptium\*\bin\java.exe",
    "C:\Program Files\Java\*\bin\java.exe",
    "C:\Program Files\Microsoft\jdk-*\bin\java.exe",
    "C:\Program Files\Amazon Corretto\*\bin\java.exe",
    (Join-Path $WorkDir "jdk\extracted\*\bin\java.exe")
  )
  foreach ($pattern in $commonPatterns) {
    $found = Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
  }

  Write-Host "No Java installation found -- downloading a portable Eclipse Temurin JDK 21 (zip, no installer, no admin rights, lives entirely under $WorkDir\jdk\)..."
  try {
    $jdkDir = Join-Path $WorkDir "jdk"
    $jdkZip = Join-Path $jdkDir "temurin21.zip"
    $jdkExtract = Join-Path $jdkDir "extracted"
    New-Item -ItemType Directory -Force -Path $jdkDir | Out-Null
    Invoke-WebRequest -Uri "https://api.adoptium.net/v3/binary/latest/21/ga/windows/x64/jdk/hotspot/normal/eclipse" -OutFile $jdkZip -UseBasicParsing -TimeoutSec 300
    Expand-Archive -Path $jdkZip -DestinationPath $jdkExtract -Force
    $found = Get-ChildItem -Path (Join-Path $jdkExtract "*\bin\java.exe") -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
      Write-Host "Portable JDK 21 ready: $($found.FullName)"
      return $found.FullName
    }
  } catch {
    Write-Host "Could not download/extract a portable JDK: $_"
  }
  return $null
}

$javaExe = Resolve-JavaExe
$javaOk = $false
if ($javaExe) {
  try {
    $javaVersionOutput = (& $javaExe -version 2>&1 | Out-String)
    Write-Host $javaVersionOutput
    $javaOk = $true
  } catch {
    Write-Host "Found $javaExe but could not run it: $_"
  }
}
Write-Result $javaOk "Java available at: $javaExe (needed for OTP2; if the version is below 21, the OTP2 graph build below will likely refuse to start -- paste the error text back if so)"
$summary["java"] = $javaOk

if (-not (Test-Path $OsmPbf)) {
  Write-Result $false "Not found: $OsmPbf -- expected the existing Sofia OSM extract. Check the path."
  $summary["osm_pbf"] = $false
} else {
  $osmSize = [math]::Round((Get-Item $OsmPbf).Length / 1MB, 1)
  Write-Result $true "OSM extract found: $OsmPbf ($osmSize MB)"
  $summary["osm_pbf"] = $true
}

$freeGb = [math]::Round((Get-PSDrive -Name ($WorkDir.Substring(0,1))).Free / 1GB, 1)
Write-Host "Free space on the drive for ${WorkDir}: ${freeGb} GB (5+ GB recommended for a comfortable graph+data build)"

# ---------------------------------------------------------------------------
Write-Step "2. Downloading the Sofia Traffic static GTFS feed"
# ---------------------------------------------------------------------------

$gtfsZip = Join-Path $WorkDir "gtfs_static.zip"
$gtfsOk = $false
if (Test-Path $gtfsZip) {
  Write-Host "Already downloaded: $gtfsZip -- skipping (delete the file to re-download)"
  $gtfsOk = $true
} else {
  try {
    Invoke-WebRequest -Uri "https://gtfs.sofiatraffic.bg/api/v1/static" -OutFile $gtfsZip -UseBasicParsing -TimeoutSec 120
    $gtfsSize = [math]::Round((Get-Item $gtfsZip).Length / 1MB, 1)
    Write-Result $true "GTFS feed downloaded: $gtfsZip (${gtfsSize} MB)"
    $gtfsOk = $true
  } catch {
    Write-Result $false "Could not download the GTFS feed: $_"
  }
}
$summary["gtfs"] = $gtfsOk

if ($gtfsOk) {
  try {
    $gtfsInspectDir = Join-Path $WorkDir "gtfs_inspect"
    if (-not (Test-Path $gtfsInspectDir)) {
      Expand-Archive -Path $gtfsZip -DestinationPath $gtfsInspectDir -Force
    }
    Write-Host "Files inside the feed:"
    Get-ChildItem $gtfsInspectDir | Select-Object Name, @{N='KB';E={[math]::Round($_.Length/1KB)}} | Format-Table | Out-String | Write-Host
    $agencyPath = Join-Path $gtfsInspectDir "agency.txt"
    if (Test-Path $agencyPath) {
      Write-Host "agency.txt (who publishes the routes inside this feed):"
      Get-Content $agencyPath | Write-Host
    }
  } catch {
    Write-Host "Could not unpack/inspect the GTFS feed for a sanity check (not critical, the engines unpack it themselves): $_"
  }
}

# ---------------------------------------------------------------------------
Write-Step "3. OpenTripPlanner 2"
# ---------------------------------------------------------------------------

$otpDir = Join-Path $WorkDir "otp"
$otpGraphData = Join-Path $otpDir "graph-data"
New-Item -ItemType Directory -Force -Path $otpGraphData | Out-Null
$otpJar = Join-Path $otpDir "otp-shaded-$OtpVersion.jar"

$otpDownloadOk = Test-Path $otpJar
if (-not $otpDownloadOk) {
  # OTP2's runnable-jar Maven coordinates have changed across versions --
  # try both known layouts in turn instead of guessing a single one.
  $otpUrlCandidates = @(
    "https://repo1.maven.org/maven2/org/opentripplanner/otp-shaded/$OtpVersion/otp-shaded-$OtpVersion.jar",
    "https://repo1.maven.org/maven2/org/opentripplanner/otp/$OtpVersion/otp-$OtpVersion-shaded.jar"
  )
  foreach ($otpUrl in $otpUrlCandidates) {
    if ($otpDownloadOk) { break }
    try {
      Write-Host "Downloading $otpUrl ..."
      Invoke-WebRequest -Uri $otpUrl -OutFile $otpJar -UseBasicParsing -TimeoutSec 180
      $otpDownloadOk = $true
      Write-Result $true "OTP2 $OtpVersion downloaded ($otpUrl)"
    } catch {
      Write-Host "Did not work: $otpUrl ($_)"
    }
  }
  if (-not $otpDownloadOk) {
    Write-Result $false "Could not download OTP2 $OtpVersion from either known path. Open https://repo1.maven.org/maven2/org/opentripplanner/otp-shaded/ in a browser, find the real version/file name, and pass it to the script via -OtpVersion (or send me the list and I will fix it)."
  }
} else {
  Write-Host "OTP2 jar already downloaded, skipping"
}
$summary["otp_download"] = $otpDownloadOk

if ($otpDownloadOk -and $summary["osm_pbf"] -and $gtfsOk -and $javaOk) {
  # OTP scans the graph-data folder itself and picks up *.osm.pbf + *gtfs*.zip inside it
  Copy-Item $OsmPbf (Join-Path $otpGraphData "sofia.osm.pbf") -Force
  Copy-Item $gtfsZip (Join-Path $otpGraphData "sofia-gtfs.zip") -Force

  Write-Host "Building the OTP2 graph (can take a few minutes -- log is written live)..."
  $otpBuildLog = Join-Path $logDir "otp-build.log"
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $javaExe `
    -ArgumentList "-Xmx$OtpMemory","-jar",$otpJar,"--build","--save",$otpGraphData `
    -NoNewWindow -Wait -PassThru `
    -RedirectStandardOutput $otpBuildLog -RedirectStandardError (Join-Path $logDir "otp-build-err.log")
  $sw.Stop()
  $otpBuildOk = ($proc.ExitCode -eq 0)
  Write-Result $otpBuildOk "OTP2 graph build finished in $([math]::Round($sw.Elapsed.TotalSeconds))s, exit code $($proc.ExitCode) -- log: $otpBuildLog"
  $summary["otp_build_seconds"] = [math]::Round($sw.Elapsed.TotalSeconds)
  $summary["otp_build_ok"] = $otpBuildOk

  $graphFile = Join-Path $otpGraphData "graph.obj"
  if (Test-Path $graphFile) {
    $graphSizeMb = [math]::Round((Get-Item $graphFile).Length / 1MB, 1)
    Write-Host "Built graph size: ${graphSizeMb} MB"
    $summary["otp_graph_mb"] = $graphSizeMb
  }

  if ($otpBuildOk) {
    if (Test-PortOpen $OtpPort) {
      Write-Host "Something is already listening on port $OtpPort -- most likely an OTP2 server from an earlier run of this script is still up. Not starting a second instance (that is what caused the 'log file used by another process' error). Just open http://localhost:$OtpPort -- it should already work."
      $summary["otp_server_started"] = "already running"
    } else {
      Write-Host "Starting the OTP2 server on port $OtpPort in a separate window (leave it open while testing)..."
      $otpServerLog = Join-Path $logDir ("otp-server-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
      Start-Process -FilePath "powershell" -ArgumentList @(
        "-NoExit","-Command",
        "& `"$javaExe`" -Xmx$OtpMemory -jar `"$otpJar`" --load `"$otpGraphData`" --port $OtpPort *>&1 | Tee-Object -FilePath `"$otpServerLog`""
      )
      Write-Host "In 20-40 seconds (the graph loads into memory) open http://localhost:$OtpPort -- log: $otpServerLog"
      $summary["otp_server_started"] = "start attempted (not yet verified -- check the log or the URL)"
    }
  }
} else {
  Write-Host "Skipping the OTP2 build/start -- prerequisites not met (java/jar/osm/gtfs)"
  $summary["otp_build_ok"] = $false
}

# ---------------------------------------------------------------------------
Write-Step "4. Motis"
# ---------------------------------------------------------------------------

$motisDir = Join-Path $WorkDir "motis"
$motisDataDir = Join-Path $motisDir "data"
New-Item -ItemType Directory -Force -Path $motisDataDir | Out-Null
$motisExe = Join-Path $motisDir "motis.exe"

$motisDownloadOk = Test-Path $motisExe
if (-not $motisDownloadOk) {
  try {
    Write-Host "Looking up the latest Windows release of Motis on GitHub..."
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/motis-project/motis/releases/latest" -TimeoutSec 60
    $asset = $release.assets | Where-Object {
      ($_.name -match "windows") -or ($_.name -match "win64") -or ($_.name -match "\.exe$") -or (($_.name -match "\.zip$") -and ($_.name -match "win"))
    } | Select-Object -First 1
    if (-not $asset) {
      Write-Host "Assets available in release $($release.tag_name):"
      $release.assets | ForEach-Object { Write-Host " - $($_.name)" }
      throw "Could not auto-detect a Windows asset -- pick one from the list above manually, download it from $($release.html_url), and save it as $motisExe (or as motis.zip next to it -- re-running the script will unpack it if the file is named motis.zip)"
    }
    Write-Host "Downloading $($asset.name) ..."
    $downloadPath = Join-Path $motisDir $asset.name
    Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $downloadPath -UseBasicParsing -TimeoutSec 300
    if ($asset.name -match "\.zip$") {
      Expand-Archive -Path $downloadPath -DestinationPath $motisDir -Force
      $foundExe = Get-ChildItem $motisDir -Recurse -Filter "motis.exe" | Select-Object -First 1
      # The zip may already extract motis.exe directly to $motisExe's own
      # path -- Copy-Item onto itself errors, so only copy when it actually
      # landed somewhere else (e.g. a nested folder inside the archive).
      if ($foundExe -and $foundExe.FullName -ne $motisExe) {
        Copy-Item $foundExe.FullName $motisExe -Force
      } elseif (-not $foundExe) {
        Write-Host "Extracted $($asset.name) but did not find motis.exe inside it -- check $motisDir manually"
      }
    } else {
      Copy-Item $downloadPath $motisExe -Force
    }
    $motisDownloadOk = Test-Path $motisExe
    Write-Result $motisDownloadOk "Motis $($release.tag_name) downloaded"
  } catch {
    Write-Result $false "Could not download Motis: $_"
  }
} else {
  Write-Host "motis.exe already present, skipping download"
}
$summary["motis_download"] = $motisDownloadOk

if ($motisDownloadOk -and $summary["osm_pbf"] -and $gtfsOk) {
  Copy-Item $OsmPbf (Join-Path $motisDataDir "sofia.osm.pbf") -Force
  Copy-Item $gtfsZip (Join-Path $motisDataDir "sofia-gtfs.zip") -Force

  Push-Location $motisDir
  try {
    Write-Host "--- motis.exe --help (for reference, in case the commands below do not match your version) ---"
    & $motisExe "--help" 2>&1 | Tee-Object -FilePath (Join-Path $logDir "motis-help.log") | Write-Host

    Write-Host "--- motis.exe config --help (checking the real argument syntax before guessing) ---"
    & $motisExe "config" "--help" 2>&1 | Tee-Object -FilePath (Join-Path $logDir "motis-config-help.log") | Write-Host

    # motis-config-help.log confirmed the real syntax: "motis config
    # [PATHS...]" takes actual FILE paths (type auto-detected by extension:
    # *.osm.pbf vs everything else treated as a timetable), and it writes
    # config.yml to the CURRENT WORKING DIRECTORY (we are already inside
    # $motisDir via Push-Location) -- not into the input files' own folder.
    # The previous guess passed a bare directory, which matched neither
    # extension rule and produced an empty, useless config.
    $motisConfigYml = Join-Path $motisDir "config.yml"
    if (Test-Path $motisConfigYml) {
      # Remove any stale config from an earlier failed attempt so a fresh
      # one is unambiguously regenerated below, rather than silently
      # reusing old (possibly empty/wrong) settings.
      Remove-Item $motisConfigYml -Force
    }

    Write-Host "Generating the Motis config (motis.exe config ./data/sofia.osm.pbf ./data/sofia-gtfs.zip)..."
    & $motisExe "config" "./data/sofia.osm.pbf" "./data/sofia-gtfs.zip" 2>&1 |
      Tee-Object -FilePath (Join-Path $logDir "motis-config.log") | Write-Host

    $motisConfigOk = Test-Path $motisConfigYml
    if ($motisConfigOk) {
      Write-Host "config.yml generated: $motisConfigYml"
      Copy-Item $motisConfigYml (Join-Path $logDir "motis-config.yml") -Force
    } else {
      Write-Host "Still no config.yml at $motisConfigYml -- check motis-config-help.log and motis-config.log above for the actual expected syntax. Skipping import (running it against a missing/stale config just produces another confusing error)."
    }
    $summary["motis_config_ok"] = $motisConfigOk

    if ($motisConfigOk) {
      # config.yml as generated by "motis config" has no server/port section
      # at all -- it only covers import settings (osm/gtfs/tiles/timetable).
      # The previous attempt guessed the CLI flag "--http_port=8081", which
      # motis.exe rejected outright ("unrecognised option"). Rather than
      # guess a second time blindly: (a) capture "motis.exe server --help"
      # to its own log FIRST, with a hard timeout in case it starts a real
      # server instead of printing help and exiting, so the exact real
      # flag/config-key name is known no matter what happens below; then
      # (b) add a best-guess "server: host/port" block to config.yml (a
      # common layout for this kind of tool) and drop the CLI flag entirely,
      # since motis.exe reads config.yml from the current directory anyway
      # (that's where "motis config" itself wrote it).
      Write-Host "--- motis.exe server --help (checking the real server flags before guessing a port) ---"
      $serverHelpLog = Join-Path $logDir "motis-server-help.log"
      $helpJob = Start-Job -ScriptBlock { param($exe) & $exe "server" "--help" 2>&1 | Out-String } -ArgumentList $motisExe
      $null = Wait-Job $helpJob -Timeout 15
      if ($helpJob.State -eq "Running") {
        Write-Host "motis.exe server --help did not exit within 15s -- it may have started a real server instead of printing help. Stopping it (this is expected/harmless if so)."
        Stop-Job $helpJob -ErrorAction SilentlyContinue
      } else {
        $serverHelpText = Receive-Job $helpJob
        $serverHelpText | Out-File -FilePath $serverHelpLog -Encoding utf8
        Write-Host $serverHelpText
      }
      Remove-Job $helpJob -Force -ErrorAction SilentlyContinue

      $configText = Get-Content $motisConfigYml -Raw
      if ($configText -notmatch "(?m)^server:") {
        Add-Content -Path $motisConfigYml -Value "server:`n  host: `"0.0.0.0`"`n  port: $MotisPort`n"
        Write-Host "Added a best-guess 'server: host/port' block to config.yml ($motisConfigYml) since the generated file had none. If motis.exe ignores this and still refuses to listen on $MotisPort, check $serverHelpLog from this run -- it has the real flag/key name and the fix is then a one-line change, no more guessing."
        Copy-Item $motisConfigYml (Join-Path $logDir "motis-config.yml") -Force
      }
    }

    if ($motisConfigOk) {
      Write-Host "Importing the data (motis.exe import) -- can take a few minutes..."
      $sw2 = [System.Diagnostics.Stopwatch]::StartNew()
      & $motisExe "import" 2>&1 | Tee-Object -FilePath (Join-Path $logDir "motis-import.log") | Write-Host
      $sw2.Stop()
      $motisImportOk = ($LASTEXITCODE -eq 0)
      Write-Result $motisImportOk "Motis import finished in $([math]::Round($sw2.Elapsed.TotalSeconds))s"
      $summary["motis_import_seconds"] = [math]::Round($sw2.Elapsed.TotalSeconds)
      $summary["motis_import_ok"] = $motisImportOk
    } else {
      $motisImportOk = $false
      $summary["motis_import_ok"] = $false
    }

    if ($motisImportOk) {
      if (Test-PortOpen $MotisPort) {
        Write-Host "Something is already listening on port $MotisPort -- most likely a Motis server from an earlier run is still up. Not starting a second instance. Just open http://localhost:$MotisPort."
        $summary["motis_server_started"] = "already running"
      } else {
        Write-Host "Starting the Motis server in a separate window (port comes from config.yml's server/port block now, not a CLI flag -- the earlier --http_port flag was confirmed wrong: 'unrecognised option')..."
        $motisServerLog = Join-Path $logDir ("motis-server-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))
        Start-Process -FilePath "powershell" -ArgumentList @(
          "-NoExit","-Command",
          "cd `"$motisDir`"; .\motis.exe server *>&1 | Tee-Object -FilePath `"$motisServerLog`""
        )
        Write-Host "In 10-20 seconds open http://localhost:$MotisPort -- log: $motisServerLog. If it still fails, paste the error plus the contents of $logDir\motis-server-help.log back and the config key/flag will get fixed for good."
        $summary["motis_server_started"] = "start attempted (not yet verified -- check the log or the URL)"
      }
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Host "Skipping the Motis import/start -- prerequisites not met (exe/osm/gtfs)"
  $summary["motis_import_ok"] = $false
}

# ---------------------------------------------------------------------------
Write-Step "5. Summary"
# ---------------------------------------------------------------------------
$summary | Format-Table -AutoSize | Out-String | Write-Host
Write-Host "Logs are in: $logDir"
Write-Host "Send Claude the log contents plus screenshots/results of the manual route checks described at the top of this script."
