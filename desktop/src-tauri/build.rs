fn main() {
    // What's new in this version, for the site to show once after it updates (BRIDGE in main.rs).
    println!("cargo:rerun-if-env-changed=KRIDA_RELEASE_NOTES");
    // The site is remote, so its calls into the app are allowed one command at a time (capabilities/default.json).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "mpv_load",
            "mpv_warm",
            "mpv_seek",
            "mpv_set",
            "mpv_stop",
            "mpv_frame_light",
            "update_status",
            "update_check",
            "update_restart",
            "sign_in_listen",
            "sign_in_open",
            "open_fullscreen",
            "set_open_fullscreen",
        ]),
    ))
    .expect("failed to run tauri-build");
}
