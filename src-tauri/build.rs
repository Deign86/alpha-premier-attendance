fn main() {
    println!("cargo:rustc-link-arg-bin=alpha-premier-attendance=/SUBSYSTEM:WINDOWS");
    tauri_build::build()
}

