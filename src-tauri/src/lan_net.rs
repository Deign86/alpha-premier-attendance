//! LAN network introspection for the live attendance viewer.
//!
//! The front-desk laptop binds the Axum viewer server to its active office
//! LAN/Wi-Fi IP (never loopback for the shareable URL). This module detects
//! reachable private IPv4 candidates, prefers the real office interface over
//! virtual adapters, and (on Windows) reads the current network profile so the
//! app can warn when a Public profile is likely to block inbound connections.

use std::net::IpAddr;

/// Names commonly used by virtual adapters that should not be offered as the
/// office viewer address (they are usually not reachable from other devices).
const VIRTUAL_INTERFACE_HINTS: &[&str] = &[
    "virtualbox",
    "vmware",
    "vethernet",
    "hyper-v",
    "hyperv",
    "docker",
    "wsl",
    "tailscale",
    "zerotier",
    "npcap",
    "loopback",
    "bluetooth",
    "hamachi",
    "tun",
    "tap",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LanInterface {
    pub name: String,
    pub ip: IpAddr,
}

/// A candidate is a private RFC1918 IPv4 that is not loopback and not
/// link-local (169.254.0.0/16). IPv6 is intentionally excluded: the viewer is
/// consumed from IPv4 LAN browsers and binding IPv6 adds no office value.
fn is_office_lan_candidate(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4.is_private() && !v4.is_link_local() && !v4.is_loopback(),
        IpAddr::V6(_) => false,
    }
}

fn looks_virtual(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    VIRTUAL_INTERFACE_HINTS
        .iter()
        .any(|hint| lower.contains(hint))
}

fn is_known_virtual_host_only(ip: IpAddr) -> bool {
    matches!(ip, IpAddr::V4(v4) if v4.octets()[0] == 192 && v4.octets()[1] == 168 && v4.octets()[2] == 56)
}

fn is_wireless(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    lower.contains("wi-fi") || lower.contains("wifi") || lower.contains("wlan") || lower.contains("wireless")
}

/// Most offices use a 192.168.x.x Wi-Fi/LAN subnet; prefer it, then 10.x.x.x,
/// then 172.16-31.x.x. This is only a tie-breaker after virtual filtering.
fn is_preferred_private(ip: IpAddr) -> bool {
    matches!(ip, IpAddr::V4(v4) if v4.octets()[0] == 192 && v4.octets()[1] == 168)
}

/// Enumerate candidate office LAN IPv4 interfaces, best first.
pub fn detect_lan_interfaces() -> Vec<LanInterface> {
    let mut candidates = get_if_addrs::get_if_addrs()
        .map(|interfaces| {
            interfaces
                .into_iter()
                .filter_map(|interface| {
                    let ip = interface.ip();
                    if !is_office_lan_candidate(ip) {
                        return None;
                    }
                    Some(LanInterface {
                        name: interface.name,
                        ip,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    candidates.sort_by_key(|item| {
        (
            looks_virtual(&item.name) || is_known_virtual_host_only(item.ip),
            !is_wireless(&item.name),
            !is_preferred_private(item.ip),
        )
    });
    candidates
}

/// Best single LAN IP to bind and advertise, when one exists.
pub fn pick_active_lan_ip() -> Option<IpAddr> {
    detect_lan_interfaces().into_iter().map(|item| item.ip).next()
}

/// True when `ip` belongs to an active network adapter on this machine
/// (loopback always counts). Used to warn when a configured `lan.bind_address`
/// is stale, which is one of the most common reasons the viewer runs locally
/// but other devices cannot connect.
pub fn is_address_on_active_adapter(ip: IpAddr) -> bool {
    if ip.is_loopback() {
        return true;
    }
    detect_lan_interfaces().iter().any(|item| item.ip == ip)
}

/// Best-effort check for an inbound Windows Firewall allow rule covering the
/// LAN viewer port. Returns `Some(true)` when at least one matching rule
/// exists, `Some(false)` when none does, and `None` when the check could not
/// run (non-Windows, missing PowerShell, or the query timed out).
pub async fn detect_firewall_allow_rule(port: u16) -> Option<bool> {
    let script = r#"
try {
  $f = Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -contains '__PORT__' };
  if (-not $f) { '0' }
  else {
    $count = 0;
    foreach ($item in $f) {
      $rules = $item | Get-NetFirewallRule -ErrorAction SilentlyContinue;
      if ($rules) { $count += ($rules | Where-Object { $_.Direction -eq 'Inbound' -and $_.Enabled -eq 'True' -and $_.Action -eq 'Allow' } | Measure-Object).Count }
    }
    if ($count -gt 0) { '1' } else { '0' }
  }
} catch { 'x' }
"#
    .replace("__PORT__", &port.to_string());
    let Ok(child) = tokio::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
    else {
        return None;
    };
    let output = tokio::time::timeout(std::time::Duration::from_secs(6), child.wait_with_output())
        .await
        .ok()
        .and_then(|result| result.ok());
    let Some(output) = output else { return None; };
    match String::from_utf8_lossy(&output.stdout).trim() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

/// Windows network profile category. `Public` blocks most inbound LAN traffic
/// by default, so the app can surface plain-language firewall guidance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum NetworkProfile {
    Public,
    Private,
    Domain,
    Unknown,
}

/// Firewall allow-rule state for the LAN viewer port, for operator guidance.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FirewallRuleState {
    /// At least one inbound allow rule covers the viewer port.
    Present,
    /// No inbound allow rule was found for the viewer port.
    Missing,
    /// The check could not run (non-Windows, or PowerShell unavailable).
    Unknown,
}

impl FirewallRuleState {
    pub fn as_str(self) -> &'static str {
        match self {
            FirewallRuleState::Present => "present",
            FirewallRuleState::Missing => "missing",
            FirewallRuleState::Unknown => "unknown",
        }
    }
}

impl NetworkProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            NetworkProfile::Public => "public",
            NetworkProfile::Private => "private",
            NetworkProfile::Domain => "domain",
            NetworkProfile::Unknown => "unknown",
        }
    }

    /// Windows treats a Public profile as untrusted and blocks inbound
    /// connections to apps that have not been explicitly allowed.
    pub fn likely_blocks_inbound(self) -> bool {
        matches!(self, NetworkProfile::Public)
    }
}

fn parse_network_category(text: &str) -> NetworkProfile {
    match text.trim() {
        "0" => NetworkProfile::Public,
        "1" => NetworkProfile::Private,
        "2" => NetworkProfile::Domain,
        _ => NetworkProfile::Unknown,
    }
}

/// Read the current Windows network profile (0=Public, 1=Private,
/// 2=DomainAuthenticated) via `Get-NetConnectionProfile`. Non-Windows or
/// missing PowerShell degrades to `Unknown` without error.
pub async fn detect_network_profile() -> NetworkProfile {
    let Ok(child) = tokio::process::Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-NetConnectionProfile | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' } | Select-Object -First 1 -ExpandProperty NetworkCategory",
        ])
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .spawn()
    else {
        return NetworkProfile::Unknown;
    };
    let output = tokio::time::timeout(std::time::Duration::from_secs(3), child.wait_with_output())
        .await
        .ok()
        .and_then(|result| result.ok());
    let Some(output) = output else { return NetworkProfile::Unknown; };
    parse_network_category(&String::from_utf8_lossy(&output.stdout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::Ipv4Addr;

    #[test]
    fn filters_loopback_and_link_local_and_ipv6() {
        assert!(is_office_lan_candidate(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50))));
        assert!(is_office_lan_candidate(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 8))));
        assert!(!is_office_lan_candidate(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(!is_office_lan_candidate(IpAddr::V4(Ipv4Addr::new(169, 254, 10, 10))));
        assert!(!is_office_lan_candidate(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)));
        assert!(!is_office_lan_candidate(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[test]
    fn loopback_counts_as_an_active_adapter() {
        assert!(is_address_on_active_adapter(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    }

    #[test]
    fn virtual_hints_are_detected() {
        assert!(looks_virtual("vEthernet (WSL)"));
        assert!(looks_virtual("VirtualBox Host-Only Network"));
        assert!(looks_virtual("VMware Network Adapter VMnet8"));
        assert!(!looks_virtual("Wi-Fi"));
        assert!(!looks_virtual("Ethernet"));
    }

    #[test]
    fn sorts_real_interfaces_first() {
        let mut candidates = vec![
            LanInterface { name: "vEthernet (WSL)".into(), ip: IpAddr::V4(Ipv4Addr::new(172, 28, 0, 1)) },
            LanInterface { name: "Wi-Fi".into(), ip: IpAddr::V4(Ipv4Addr::new(192, 168, 1, 50)) },
            LanInterface { name: "Ethernet".into(), ip: IpAddr::V4(Ipv4Addr::new(10, 0, 0, 8)) },
        ];
        candidates.sort_by_key(|item| (looks_virtual(&item.name), !is_preferred_private(item.ip)));
        assert_eq!(candidates[0].ip.to_string(), "192.168.1.50");
        assert_eq!(candidates[1].ip.to_string(), "10.0.0.8");
        assert_eq!(candidates[2].ip.to_string(), "172.28.0.1");
    }

    #[test]
    fn parses_windows_network_categories() {
        assert_eq!(parse_network_category("0"), NetworkProfile::Public);
        assert_eq!(parse_network_category("1"), NetworkProfile::Private);
        assert_eq!(parse_network_category("2"), NetworkProfile::Domain);
        assert_eq!(parse_network_category(""), NetworkProfile::Unknown);
        assert_eq!(parse_network_category("garbage\n"), NetworkProfile::Unknown);
    }
}
