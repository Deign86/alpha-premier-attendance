fn main() {
    if std::env::var("PROFILE").as_deref() == Ok("release") {
        println!("cargo:rustc-link-arg-bin=alpha-premier-attendance=/SUBSYSTEM:WINDOWS");
    }
    tauri_build::build()
}
