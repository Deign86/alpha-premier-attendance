#![allow(dead_code)] // each isolated target uses a subset of these shared helpers
// Loader and section registry for the Rust-owned payroll golden contract
// (shared/payroll-fixtures.json). Included with #[path] by the isolated
// payroll test targets so each of them reads the same bytes.
//
// Every top-level section must be registered in SECTIONS with the one test
// target that consumes it. `assert_owned_consumed` fails when the JSON gains an
// unregistered section, when a registered section is missing from the JSON, or
// when the calling target did not read all the sections it owns.
use serde_json::Value;
use std::sync::Mutex;

const RAW: &str = include_str!("../../../shared/payroll-fixtures.json");

/// Metadata keys that carry no cases.
pub const META_KEYS: &[&str] = &["version", "description"];

/// (section, owning test target)
pub const SECTIONS: &[(&str, &str)] = &[
    ("baseInput", "cutoff_freeze"),
    ("cutoffCases", "cutoff_freeze"),
    ("internDaily", "payroll_hours_accuracy"),
    ("internCutoffs", "intern_payroll_isolated"),
];

static CONSUMED: Mutex<Vec<String>> = Mutex::new(Vec::new());

pub fn fixture() -> Value {
    let fixture: Value = serde_json::from_str(RAW).expect("valid shared payroll fixtures");
    assert_eq!(fixture["version"], 2, "fixture version");
    fixture
}

/// Returns one registered section, recording that `owner` consumed it.
pub fn section(owner: &str, name: &str) -> Value {
    assert!(SECTIONS.contains(&(name, owner)), "section {name} is not registered for {owner}");
    CONSUMED.lock().unwrap().push(name.to_owned());
    let mut fixture = fixture();
    let value = fixture[name].take();
    assert!(!value.is_null(), "fixture section {name} is missing");
    if let Some(items) = value.as_array() {
        assert!(!items.is_empty(), "fixture section {name} is empty");
    }
    value
}

pub fn assert_owned_consumed(owner: &str) {
    let fixture = fixture();
    let mut keys: Vec<&str> = fixture
        .as_object()
        .expect("fixture object")
        .keys()
        .map(String::as_str)
        .filter(|key| !META_KEYS.contains(key))
        .collect();
    keys.sort_unstable();
    let mut registered: Vec<&str> = SECTIONS.iter().map(|(name, _)| *name).collect();
    registered.sort_unstable();
    assert_eq!(keys, registered, "every fixture section must be registered with a consumer");

    let consumed = CONSUMED.lock().unwrap();
    for (name, section_owner) in SECTIONS {
        if *section_owner == owner {
            assert!(consumed.iter().any(|seen| seen == name), "{owner} never consumed fixture section {name}");
        }
    }
}
