<#
.SYNOPSIS
    Voicebox Name Pronunciation Integration Example (PowerShell)
.DESCRIPTION
    Demonstrates fetching phonetic dictionaries and generating SSML phoneme
    elements for local or remote TTS name synthesis using Invoke-RestMethod.
#>

param(
    [string]$BaseUrl = $env:BASE_URL,
    [string]$VoiceboxKey = $env:VOICEBOX_KEY
)

if (-not $BaseUrl) {
    $BaseUrl = "http://localhost:3001"
}
$BaseUrl = $BaseUrl.TrimEnd('/')

function Escape-XmlText([string]$text) {
    if (-not $text) { return "" }
    return [System.Security.SecurityElement]::Escape($text)
}

function Fetch-AllPronunciations {
    param(
        [string]$Url = $BaseUrl,
        [string]$Key = $VoiceboxKey
    )

    $headers = @{}
    if ($Key) {
        $headers["x-voicebox-key"] = $Key
    }

    $endpoint = "$Url/api/voicebox/pronunciations"
    if ($Key) {
        $endpoint += "?key=$([Uri]::EscapeDataString($Key))"
    }

    try {
        $response = Invoke-RestMethod -Uri $endpoint -Method Get -Headers $headers -ContentType "application/json"
        $items = @()
        if ($response -is [System.Array]) {
            $items = $response
        } elseif ($response.pronunciations) {
            $items = $response.pronunciations
        }

        $map = @{}
        foreach ($item in $items) {
            if ($item.displayName) {
                $lookupKey = $item.displayName.Trim().ToLower()
                $map[$lookupKey] = $item
            }
        }
        return $map
    } catch {
        Write-Warning "Failed to fetch pronunciations from $($endpoint): $_"
        return @{}
    }

}

function Get-Pronunciation {
    param(
        [string]$Name,
        [hashtable]$PronunciationMap
    )

    if (-not $Name -or -not $PronunciationMap) { return $null }
    $lookupKey = $Name.Trim().ToLower()
    if ($PronunciationMap.ContainsKey($lookupKey)) {
        return $PronunciationMap[$lookupKey]
    }
    return $null
}

function Build-NameSsml {
    param(
        [string]$Name,
        [object]$Pronunciation
    )

    $escapedName = Escape-XmlText $Name
    if (-not $Pronunciation -or -not $Pronunciation.phoneticIpa) {
        return $escapedName
    }

    $cleanIpa = $Pronunciation.phoneticIpa.Trim().Trim('/')
    $escapedIpa = Escape-XmlText $cleanIpa
    return "<phoneme alphabet=`"ipa`" ph=`"$escapedIpa`">$escapedName</phoneme>"
}

# Execution Demonstration
Write-Host "[Voicebox Integration PS1] Connecting to $BaseUrl..."
$pronunciationMap = Fetch-AllPronunciations -Url $BaseUrl -Key $VoiceboxKey
Write-Host "[Voicebox Integration PS1] Loaded $($pronunciationMap.Count) pronunciation override(s)."

$testNames = @("Deign", "Bea", "Carlos", "Maria", "NonExistentName")
foreach ($testName in $testNames) {
    $pron = Get-Pronunciation -Name $testName -PronunciationMap $pronunciationMap
    $ssml = Build-NameSsml -Name $testName -Pronunciation $pron
    Write-Host " - Name: `"$testName`" -> SSML: $ssml"
}

