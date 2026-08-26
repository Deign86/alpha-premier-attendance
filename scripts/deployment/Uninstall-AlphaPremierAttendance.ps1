#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Action1 RMM Silent Uninstaller for Alpha Premier Attendance.
.DESCRIPTION
    Silently removes Alpha Premier Attendance under SYSTEM context.
    Locates the uninstall string from 64-bit and 32-bit registry hives,
    executes silent uninstallation (NSIS /S or MSI /x), captures exit codes,
    cleans up leftover desktop shortcuts / app data, and logs to %ProgramData%.

.ACTION1 CONFIGURATION
    Package Type: Custom Software Package
    Uninstall Command:
        powershell.exe -ExecutionPolicy Bypass -NoProfile -NonInteractive -File Uninstall-AlphaPremierAttendance.ps1
    Success Exit Codes: 0, 3010

.PARAMETER KeepData
    Optional switch to preserve %ProgramData%\AlphaPremierAttendance logs and configuration.
#>

[CmdletBinding()]
param(
    [switch]$KeepData
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

# --- Constants & Configuration ---
$AppName = "Alpha Premier Attendance"
$AppIdentifier = "com.alphapremier.attendance"
$LogDir = Join-Path -Path $env:ProgramData -ChildPath "AlphaPremierAttendance"
$LogFile = Join-Path -Path $LogDir -ChildPath "uninstall.log"

if (-not (Test-Path -Path $LogDir)) {
    New-Item -Path $LogDir -ItemType Directory -Force | Out-Null
}

function Write-Log {
    param(
        [Parameter(Mandatory=$true)]
        [string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR", "SUCCESS")]
        [string]$Level = "INFO"
    )
    $timestamp = (Get-Date).ToString("yyyy-MM-dd HH:mm:ss")
    $logEntry = "[$timestamp] [$Level] $Message"
    Write-Output $logEntry
    try {
        Add-Content -Path $LogFile -Value $logEntry -Encoding UTF8 -ErrorAction SilentlyContinue
    } catch {
        # Fallback if log file locked
    }
}

Write-Log "========================================================="
Write-Log "Starting uninstallation of $AppName via Action1 RMM script"
Write-Log "Running as User: $env:USERNAME on Machine: $env:COMPUTERNAME"

# --- Step 1: Locate Installed Application in Registry ---
$registryPaths = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
)

$installedEntries = Get-ItemProperty -Path $registryPaths -ErrorAction SilentlyContinue |
    Where-Object {
        ($_.DisplayName -and $_.DisplayName -like "*Alpha Premier Attendance*") -or
        ($_.PSChildName -and $_.PSChildName -eq "com.alphapremier.attendance")
    }

if (-not $installedEntries -or $installedEntries.Count -eq 0) {
    Write-Log "No installation of $AppName found in registry. Nothing to uninstall (Idempotent success)." "SUCCESS"
    exit 0
}

$exitCode = 0

foreach ($entry in $installedEntries) {
    $displayName = $entry.DisplayName
    $displayVersion = $entry.DisplayVersion
    $uninstallString = $entry.UninstallString
    $quietUninstallString = $entry.QuietUninstallString
    $installLocation = $entry.InstallLocation

    Write-Log "Found registered application: '$displayName' (Version: $displayVersion)"

    # --- Step 2: Determine & Execute Silent Uninstall Command ---
    if ($quietUninstallString) {
        Write-Log "Using QuietUninstallString: $quietUninstallString"
        # Parse command and arguments
        if ($quietUninstallString -match '^\s*"([^"]+)"\s*(.*)$') {
            $cmd = $matches[1]
            $args = $matches[2]
        } else {
            $parts = $quietUninstallString -split ' ', 2
            $cmd = $parts[0].Trim('"')
            $args = if ($parts.Length -gt 1) { $parts[1] } else { "" }
        }
        $proc = Start-Process -FilePath $cmd -ArgumentList $args -Wait -PassThru -NoNewWindow
        $exitCode = $proc.ExitCode
    } elseif ($uninstallString -match 'msiexec(\.exe)?\s*(/I|/X)\s*({[0-9A-Fa-f-]+}|\S+)' -or $entry.PSChildName -match '^{[0-9A-Fa-f-]+}$') {
        # MSI uninstallation
        $productCode = if ($entry.PSChildName -match '^{[0-9A-Fa-f-]+}$') { $entry.PSChildName } else { $matches[3] }
        $msiLog = Join-Path -Path $LogDir -ChildPath "msi_uninstall.log"
        $msiArgs = @(
            "/x",
            "$productCode",
            "/quiet",
            "/norestart",
            "/log",
            "`"$msiLog`""
        )
        Write-Log "Executing MSI quiet uninstallation: msiexec.exe $($msiArgs -join ' ')"
        $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru -NoNewWindow
        $exitCode = $proc.ExitCode
    } elseif ($uninstallString) {
        # NSIS uninstaller execution
        $uninstallerPath = $uninstallString.Trim('"')
        if ($uninstallString -match '^\s*"([^"]+)"') {
            $uninstallerPath = $matches[1]
        }
        
        if (Test-Path -Path $uninstallerPath) {
            $installDir = Split-Path -Parent $uninstallerPath
            # NSIS: /S runs silent, _?=<dir> prevents uninstaller from spawning a copy into %TEMP% and exiting early
            $nsisArgs = "/S _?=$installDir"
            Write-Log "Executing NSIS uninstaller: `"$uninstallerPath`" $nsisArgs"
            $proc = Start-Process -FilePath $uninstallerPath -ArgumentList $nsisArgs -Wait -PassThru -NoNewWindow
            $exitCode = $proc.ExitCode
        } else {
            Write-Log "Uninstaller executable not found at '$uninstallerPath'. Skipping process execution." "WARN"
        }
    }
    
    Write-Log "Uninstaller process returned Exit Code: $exitCode"
}

# --- Step 3: Clean up Residual Files and Shortcuts ---
Write-Log "Performing cleanup of leftover files and shortcuts..."

$shortcutPaths = @(
    (Join-Path -Path $env:Public -ChildPath "Desktop\Alpha Premier Attendance.lnk"),
    (Join-Path -Path $env:ProgramData -ChildPath "Microsoft\Windows\Start Menu\Programs\Alpha Premier Attendance.lnk"),
    (Join-Path -Path $env:ProgramData -ChildPath "Microsoft\Windows\Start Menu\Programs\Alpha Premier Attendance\Alpha Premier Attendance.lnk")
)

foreach ($sc in $shortcutPaths) {
    if (Test-Path -Path $sc) {
        try {
            Remove-Item -Path $sc -Force -Recurse -ErrorAction SilentlyContinue
            Write-Log "Removed residual shortcut: $sc"
        } catch {
            Write-Log "Could not remove shortcut $sc: $($_.Exception.Message)" "WARN"
        }
    }
}

# Remove default install directory if leftover
$programFilesDirs = @(
    (Join-Path -Path $env:ProgramFiles -ChildPath "Alpha Premier Attendance"),
    (Join-Path -Path ${env:ProgramFiles(x86)} -ChildPath "Alpha Premier Attendance")
)

foreach ($pfDir in $programFilesDirs) {
    if ($pfDir -and (Test-Path -Path $pfDir)) {
        try {
            Remove-Item -Path $pfDir -Force -Recurse -ErrorAction SilentlyContinue
            Write-Log "Removed residual directory: $pfDir"
        } catch {
            Write-Log "Could not remove residual directory $pfDir: $($_.Exception.Message)" "WARN"
        }
    }
}

# Remove ProgramData version marker
$markerFile = Join-Path -Path $LogDir -ChildPath "installed_version.txt"
if (Test-Path -Path $markerFile) {
    Remove-Item -Path $markerFile -Force -ErrorAction SilentlyContinue
}

if (-not $KeepData) {
    Write-Log "Cleanup complete. Uninstall log will remain in $LogFile."
}

Write-Log "Uninstallation process completed with status: $exitCode"
Write-Log "========================================================="
exit $exitCode
