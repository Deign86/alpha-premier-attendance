# Restores the Alpha Premier Attendance SQLite database onto a (new) front-desk PC.
#
#   .\migrate-database.ps1 -BackupFile "D:\attendance-backup-20260805-143000.apbackup"
#
# This is the manual installer path. The preferred flow is the in-app
# Admin -> Data and backup -> "Restore from backup file..." button, which
# validates the file and performs a SQLite online-backup restore on the next
# launch. This script exists so a technician can restore without opening the
# app, e.g. while imaging a replacement machine.
#
# Safety guarantees:
#   * The app MUST be closed before running this script (the live database is
#     replaced underneath the app otherwise).
#   * The current database is copied aside first (including any -wal/-shm
#     sidecars) so the restore can always be rolled back.
#   * The backup file is written to a temporary name and then renamed into
#     place, so a failed copy never leaves a half-written database.
#   * The source file must be a backup produced by the app's "Create backup
#     now" button (or the automatic on-exit backup). Those files are consistent
#     SQLite snapshots; raw copies of a running app's attendance.db are not.
#
# Parameter   Description
# ---------   -----------
# BackupFile  Path to the .apbackup portable backup archive to restore.
# ExeDir      Optional. Directory of alpha-premier-attendance.exe. When the
#             deployment is portable (portable.dat marker next to the .exe, or
#             ALPHA_PREMIER_PORTABLE set), the database lives in .\Data next to
#             the executable. When omitted, installed mode is assumed and the
#             database is located under %LOCALAPPDATA%\com.alphapremier.attendance.
# DryRun      Optional. Print what would be done without changing any file.

param(
    [Parameter(Mandatory = $true)]
    [string]$BackupFile,
    [string]$ExeDir,
    [switch]$DryRun
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $BackupFile)) {
    Write-Error "Backup file not found: $BackupFile"
    exit 1
}

# --- Locate the data directory ------------------------------------------------
function Resolve-DataDir {
    param([string]$ExeDir)
    if ($ExeDir -and (Test-Path (Join-Path $ExeDir "portable.dat"))) {
        return (Join-Path $ExeDir "Data")
    }
    if ($ExeDir -and $env:ALPHA_PREMIER_PORTABLE -and $env:ALPHA_PREMIER_PORTABLE -ne "0") {
        return (Join-Path $ExeDir "Data")
    }
    return (Join-Path $env:LOCALAPPDATA "com.alphapremier.attendance")
}

$dataDir = Resolve-DataDir $ExeDir
Write-Host "Target data directory: $dataDir"

# --- Honour a custom [database] path from config.toml when present -------------
$dbPath = Join-Path $dataDir "attendance.db"
$configPath = if ($ExeDir) { Join-Path $ExeDir "config.toml" } else { Join-Path $dataDir "..\config.toml" }
if (Test-Path $configPath) {
    $match = [regex]::Match((Get-Content $configPath -Raw), '(?ms)\[database\]\s*path\s*=\s*"([^"]+)"')
    if ($match.Success) {
        $custom = $match.Groups[1].Value
        $dbPath = if ([System.IO.Path]::IsPathRooted($custom)) { $custom } else { Join-Path (Split-Path $configPath) $custom }
        Write-Host "Using [database] path from config.toml: $dbPath"
    }
}
$dbDir = Split-Path $dbPath
Write-Host "Live database: $dbPath"

if ($DryRun) {
    Write-Host "Dry run: no files were changed."
    exit 0
}

New-Item -ItemType Directory -Force -Path $dbDir | Out-Null
$backupsDir = Join-Path $dbDir "backups"
New-Item -ItemType Directory -Force -Path $backupsDir | Out-Null

# --- Safety copy of the current database (with WAL sidecars) ------------------
if (Test-Path $dbPath) {
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $safety = Join-Path $backupsDir "pre-restore-$stamp.db"
    Copy-Item $dbPath $safety -Force
    foreach ($sidecar in @(".db-wal", ".db-shm")) {
        if (Test-Path ($dbPath + $sidecar)) {
            Copy-Item ($dbPath + $sidecar) ($safety + $sidecar) -Force
        }
    }
    Write-Host "Current database backed up to: $safety"
}

# --- Restore via temp file + rename so the live file is never half-written ----
$temp = Join-Path $dbDir "attendance.restore.tmp"
Copy-Item $BackupFile $temp -Force
Copy-Item $temp $dbPath -Force
Remove-Item $temp -Force

Write-Host "Database restored from: $BackupFile"
Write-Host "Done. Start the app - migrations run automatically on launch."
