#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Action1 RMM Silent Installer for Alpha Premier Attendance.
.DESCRIPTION
    Installs or upgrades Alpha Premier Attendance silently under SYSTEM context.
    Auto-detects NSIS (-setup.exe) or MSI installers in the script directory,
    unblocks files (removes MOTW), checks WebView2 prerequisites, implements
    idempotent version checks, captures exit codes, and logs to %ProgramData%.

.ACTION1 CONFIGURATION
    Package Type: Custom Software Package
    Files: Include all package files (.ps1 scripts + installer binary)
    Install Command:
        powershell.exe -ExecutionPolicy Bypass -NoProfile -NonInteractive -File Install-AlphaPremierAttendance.ps1
    Success Exit Codes: 0, 3010

.PARAMETER Force
    Forces reinstallation even if the same or newer version is already installed.
.PARAMETER InstallerPath
    Explicit path to installer. If omitted, auto-detects in script folder.
.PARAMETER InstallDir
    Custom installation directory for NSIS installer.
#>

[CmdletBinding()]
param(
    [switch]$Force,
    [string]$InstallerPath,
    [string]$InstallDir
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

# --- Constants & Configuration ---
$AppName = "Alpha Premier Attendance"
$AppIdentifier = "com.alphapremier.attendance"
$LogDir = Join-Path -Path $env:ProgramData -ChildPath "AlphaPremierAttendance"
$LogFile = Join-Path -Path $LogDir -ChildPath "install.log"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
if (-not $ScriptDir) {
    $ScriptDir = (Get-Location).Path
}

# --- Helper: Logging ---
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
Write-Log "Starting installation of $AppName via Action1 RMM script"
Write-Log "Running as User: $env:USERNAME on Machine: $env:COMPUTERNAME (OS: $((Get-CimInstance Win32_OperatingSystem).Caption))"

# --- Step 1: Detect Installer Binary ---
$installer = $null
if ($InstallerPath -and (Test-Path -Path $InstallerPath)) {
    $installer = Get-Item -Path $InstallerPath
} else {
    Write-Log "Searching for installer binary in: $ScriptDir"
    # Search order: MSI first, then NSIS exe
    $msiCandidates = Get-ChildItem -Path $ScriptDir -Filter "*.msi" -File | Sort-Object LastWriteTime -Descending
    $exeCandidates = Get-ChildItem -Path $ScriptDir -Filter "*.exe" -File | Where-Object {
        $_.Name -like "*Alpha*Premier*Attendance*.exe" -or $_.Name -like "*-setup.exe" -or $_.Name -like "*setup*.exe"
    } | Sort-Object LastWriteTime -Descending

    if ($msiCandidates -and $msiCandidates.Count -gt 0) {
        $installer = $msiCandidates[0]
    } elseif ($exeCandidates -and $exeCandidates.Count -gt 0) {
        $installer = $exeCandidates[0]
    }
}

if (-not $installer -or -not (Test-Path -Path $installer.FullName)) {
    Write-Log "CRITICAL: No valid .msi or NSIS setup .exe found in $ScriptDir" "ERROR"
    Write-Log "Available files: $((Get-ChildItem -Path $ScriptDir -File | Select-Object -ExpandProperty Name) -join ', ')" "ERROR"
    exit 1
}

Write-Log "Detected installer: $($installer.FullName) (Size: $([math]::Round($installer.Length / 1MB, 2)) MB)"

# --- Step 2: Strip Mark-of-the-Web (Zone.Identifier) ---
try {
    Write-Log "Unblocking installer file (removing Zone.Identifier)..."
    Unblock-File -Path $installer.FullName -ErrorAction SilentlyContinue
    Write-Log "File unblocked successfully."
} catch {
    Write-Log "Notice: Unblock-File returned non-fatal error: $($_.Exception.Message)" "WARN"
}

# --- Step 3: Extract Version & Registry Check (Idempotency) ---
$installerVersion = $null
try {
    if ($installer.Extension -ieq ".exe") {
        $fileVersionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($installer.FullName)
        if ($fileVersionInfo.ProductVersion) {
            $rawVer = ($fileVersionInfo.ProductVersion -split '-')[0].Trim()
            $installerVersion = [version]$rawVer
        }
    }
} catch {
    Write-Log "Could not parse installer file version: $($_.Exception.Message)" "WARN"
}

function Get-InstalledAppInfo {
    $registryPaths = @(
        "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
        "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
    )
    
    $installed = Get-ItemProperty -Path $registryPaths -ErrorAction SilentlyContinue |
        Where-Object {
            ($_.DisplayName -and $_.DisplayName -like "*Alpha Premier Attendance*") -or
            ($_.PSChildName -and $_.PSChildName -eq "com.alphapremier.attendance")
        } | Select-Object -First 1

    return $installed
}

$currentInstall = Get-InstalledAppInfo
if ($currentInstall) {
    $installedVerStr = $currentInstall.DisplayVersion
    Write-Log "Detected existing installation: '$($currentInstall.DisplayName)' Version: '$installedVerStr'"
    
    if (-not $Force -and $installerVersion -and $installedVerStr) {
        try {
            $parsedInstalled = [version]($installedVerStr -split '-')[0].Trim()
            if ($parsedInstalled -ge $installerVersion) {
                Write-Log "Installed version ($parsedInstalled) is equal to or newer than installer version ($installerVersion). Skipping install (Idempotent)." "SUCCESS"
                exit 0
            } else {
                Write-Log "Installed version ($parsedInstalled) is older than installer version ($installerVersion). Proceeding with upgrade."
            }
        } catch {
            Write-Log "Version string comparison failed. Proceeding with installation." "WARN"
        }
    } elseif ($Force) {
        Write-Log "-Force flag supplied. Proceeding with installation regardless of existing version."
    }
} else {
    Write-Log "No prior installation of $AppName detected in registry."
}

# --- Step 4: WebView2 Runtime Pre-Check ---
$webView2Installed = $false
$wv2Paths = @(
    "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-F500-4454-9A42-546513866331}",
    "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-F500-4454-9A42-546513866331}",
    "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-F500-4454-9A42-546513866331}"
)
foreach ($regPath in $wv2Paths) {
    $wv2Key = Get-ItemProperty -Path $regPath -ErrorAction SilentlyContinue
    if ($wv2Key -and $wv2Key.pv -and $wv2Key.pv -ne "0.0.0.0") {
        Write-Log "Microsoft Edge WebView2 Runtime detected (Version: $($wv2Key.pv))."
        $webView2Installed = $true
        break
    }
}
if (-not $webView2Installed) {
    Write-Log "WARNING: Microsoft Edge WebView2 Runtime not detected in registry. If the endpoint is offline and WebView2 is missing, the application frontend may not render until WebView2 is provisioned." "WARN"
}

# --- Step 5: Execute Silent Installation ---
$exitCode = 1
$msiLog = Join-Path -Path $LogDir -ChildPath "msi_install.log"

if ($installer.Extension -ieq ".msi") {
    Write-Log "Executing MSI installer quietly..."
    $msiArgs = @(
        "/i",
        "`"$($installer.FullName)`"",
        "/quiet",
        "/norestart",
        "/log",
        "`"$msiLog`""
    )
    Write-Log "Running: msiexec.exe $($msiArgs -join ' ')"
    $proc = Start-Process -FilePath "msiexec.exe" -ArgumentList $msiArgs -Wait -PassThru -NoNewWindow
    $exitCode = $proc.ExitCode
} else {
    # NSIS Installer (.exe)
    Write-Log "Executing NSIS installer silently (/S)..."
    $nsisArgs = "/S"
    if ($InstallDir) {
        # Per NSIS syntax rules: /D= must be the last parameter and unquoted
        $nsisArgs = "/S /D=$InstallDir"
    }
    Write-Log "Running: `"$($installer.FullName)`" $nsisArgs"
    $proc = Start-Process -FilePath $installer.FullName -ArgumentList $nsisArgs -Wait -PassThru -NoNewWindow
    $exitCode = $proc.ExitCode
}

# --- Step 6: Evaluate & Map Exit Codes ---
Write-Log "Installer process terminated with Exit Code: $exitCode"

switch ($exitCode) {
    0 {
        Write-Log "Installation completed successfully." "SUCCESS"
    }
    3010 {
        Write-Log "Installation completed successfully. System reboot is required (3010)." "SUCCESS"
    }
    1641 {
        Write-Log "Installation completed successfully. Installer initiated a restart (1641)." "SUCCESS"
    }
    1602 {
        Write-Log "Installation was cancelled (1602)." "ERROR"
    }
    1603 {
        Write-Log "Fatal error during installation (1603). Check $msiLog and $LogFile for details." "ERROR"
    }
    1618 {
        Write-Log "Another installation is already in progress. Complete that installation before proceeding (1618)." "ERROR"
    }
    1619 {
        Write-Log "Installation package could not be opened (1619)." "ERROR"
    }
    1638 {
        Write-Log "Another version of this product is already installed (1638)." "WARN"
        $exitCode = 0 # Treat already installed as success for RMM idempotency
    }
    Default {
        if ($exitCode -ne 0) {
            Write-Log "Installation failed with unmapped exit code: $exitCode" "ERROR"
        }
    }
}

# Write version marker on success
if ($exitCode -eq 0 -or $exitCode -eq 3010) {
    $markerFile = Join-Path -Path $LogDir -ChildPath "installed_version.txt"
    $record = "Installed: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') | Installer: $($installer.Name) | ExitCode: $exitCode"
    Set-Content -Path $markerFile -Value $record -Force -ErrorAction SilentlyContinue
}

Write-Log "Exiting script with status code: $exitCode"
Write-Log "========================================================="
exit $exitCode
