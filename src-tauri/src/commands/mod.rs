//! The Tauri commands, one module per area of the app. `lib.rs` registers them and starts the app.

pub(crate) mod attendance;
pub(crate) mod backup;
pub(crate) mod bathroom;
pub(crate) mod exports;
pub(crate) mod id_register;
pub(crate) mod kiosk;
pub(crate) mod lan;
pub(crate) mod payroll;
pub(crate) mod session;
pub(crate) mod sync;
pub(crate) mod users;
pub(crate) mod voice;

#[cfg(test)]
pub(crate) mod test_support;
