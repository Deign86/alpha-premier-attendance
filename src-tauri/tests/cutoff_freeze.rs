// Keep focused cutoff tests runnable without loading the app's Tauri/WebView2
// native dependencies into the Windows test process.
mod services {
    pub mod cutoff_payroll {
        include!("../src/services/cutoff_payroll.rs");
    }
}

#[path = "common/fixture.rs"]
mod fixture;
#[path = "common/cutoff_cases.rs"]
mod cutoff_cases;

// PINNED_SHA256 d501d4332adb3a701b59a02849f6286b30ee8594e4ad5b45a90e844680a7cba6
// is SHA-256 of shared/payroll-fixtures.json after CRLF -> LF normalization only
// (no trimming or JSON renormalization). The shared Vitest suite
// (shared/src/payroll-fixtures.pin.test.ts) enforces it; this isolated Rust
// harness documents the pin without a hash dependency. Regenerate the fixture
// from the real engine, review the diff, then update both pins together.

#[test]
fn cutoff_cases_match_the_rust_golden_contract() {
    let base = fixture::section("cutoff_freeze", "baseInput");
    let cases = fixture::section("cutoff_freeze", "cutoffCases");
    let cases = cases.as_array().expect("cutoffCases array");
    assert!(cases.iter().any(|case| case["error"].is_string()), "golden set must cover rejected inputs");

    for case in cases {
        let name = case["name"].as_str().expect("case name");
        let actual = cutoff_cases::run_cutoff(&cutoff_cases::merged_input(&base, &case["input"]));
        if let Some(error) = case["error"].as_str() {
            assert_eq!(actual["error"].as_str(), Some(error), "{name}");
        } else {
            assert_eq!(actual["expected"], case["expected"], "{name}");
        }
    }
    fixture::assert_owned_consumed("cutoff_freeze");
}

#[test]
fn intern_cutoff_never_pays_below_zero_and_never_exceeds_gross() {
    let base = fixture::section("cutoff_freeze", "baseInput");
    for late in [0.0, 10.0, 880.0, 5_000.0] {
        for actual_days in [0.0, 1.0, 11.0] {
            let input = cutoff_cases::merged_input(
                &base,
                &serde_json::json!({ "employeeType": "INTERN", "dailyRate": 80, "actualWorkingDays": actual_days, "lateDeduction": late }),
            );
            let result = cutoff_cases::run_cutoff(&input);
            let result = &result["expected"];
            let net = result["netPay"].as_i64().expect("net");
            let gross = result["grossCompensation"].as_i64().expect("gross");
            assert!(net >= 0 && net <= gross, "late {late} days {actual_days}: net {net} gross {gross}");
        }
    }
}
