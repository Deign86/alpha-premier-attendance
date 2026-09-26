// Keep focused payroll tests runnable without loading the app's Tauri/WebView2
// native dependencies into the Windows test process.
mod services {
    pub mod payroll {
        include!("../src/services/payroll.rs");
    }

    pub mod lunch_break {
        include!("../src/services/lunch_break.rs");
    }

    pub mod intern_payroll {
        include!("../src/services/intern_payroll.rs");
    }
}
