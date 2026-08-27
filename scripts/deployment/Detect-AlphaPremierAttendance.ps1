#Requires -RunAsAdministrator
<#
.SYNOPSIS
    Action1 RMM Detection Rule Script for Alpha Premier Attendance.
.DESCRIPTION
    Standalone, read-only script evaluated by Action1 before deployment.
    Queries the Windows registry uninstall hives for Alpha Premier Attendance
    and validates whether the installed version is greater than or equal to
    $ExpectedVersion.

.ACTION1 CONFIGURATION
    Rule Type: Custom Script / Exit Code Detection
    Script Type: PowerShell
    Command / Execution:
        powershell.exe -ExecutionPolicy Bypass -NoProfile -NonInteractive -File Detect-AlphaPremierAttendance.ps1
    Interpretation:
        Exit Code 0: Application is installed and meets/exceeds ExpectedVersion (Compliance OK, Skip deployment)
        Exit Code 1: Application is missing or version is lower than ExpectedVersion (Trigger deployment/update)

.NOTES
    Update $ExpectedVersion when releasing a new version.
#>

[CmdletBinding()]
param()

# Set the expected release version here (bumping this triggers updates in Action1)
$ExpectedVersion = "0.1.14"

$registryPaths = @(
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Wow6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*"
)

try {
    $items = Get-ItemProperty -Path $registryPaths -ErrorAction SilentlyContinue
    $installed = $null
    if ($items) {
        foreach ($item in $items) {
            $disp = if ($item.PSObject.Properties['DisplayName']) { [string]$item.DisplayName } else { "" }
            $child = if ($item.PSObject.Properties['PSChildName']) { [string]$item.PSChildName } else { "" }
            if (($disp -and $disp -like "*Alpha Premier Attendance*") -or ($child -eq "com.alphapremier.attendance")) {
                $installed = $item
                break
            }
        }
    }

    if (-not $installed) {
        Write-Output "DETECTION: 'Alpha Premier Attendance' not found in registry. Exit 1."
        exit 1
    }

    $dispName = if ($installed.PSObject.Properties['DisplayName']) { [string]$installed.DisplayName } else { "Alpha Premier Attendance" }
    $installedVerStr = if ($installed.PSObject.Properties['DisplayVersion']) { [string]$installed.DisplayVersion } else { "" }
    if (-not $installedVerStr) {
        Write-Output "DETECTION: '$dispName' is installed, but DisplayVersion is empty. Exit 1."
        exit 1
    }

    # Clean version string (e.g. "0.1.14" or "0.1.14-beta")
    $cleanInstalled = ($installedVerStr -split '-')[0].Trim()
    $cleanExpected = ($ExpectedVersion -split '-')[0].Trim()

    $vInstalled = [version]$cleanInstalled
    $vExpected = [version]$cleanExpected

    if ($vInstalled -ge $vExpected) {
        Write-Output "DETECTION SUCCESS: Found '$dispName' Version $installedVerStr (meets or exceeds target $ExpectedVersion). Exit 0."
        exit 0
    } else {
        Write-Output "DETECTION OUTDATED: Found '$dispName' Version $installedVerStr (target is $ExpectedVersion). Exit 1."
        exit 1
    }
} catch {
    Write-Output "DETECTION ERROR: Exception occurred during check: $($_.Exception.Message). Exit 1."
    exit 1
}
