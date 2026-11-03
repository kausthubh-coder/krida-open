//! mpv plays the picture. It draws into the app's window, under the page, which is transparent over the video
//! (src/features/player/desktop.ts in the site). The page drives it with the commands below and hears back from it
//! through "mpv" events; this side speaks mpv's JSON IPC. How mpv runs and where it draws differs by system: a process
//! of its own on Windows (mpv_windows.rs), libmpv inside the app on a Mac (mpv_mac.rs).

use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    sync::mpsc,
};

#[cfg(target_os = "macos")]
#[path = "mpv_mac.rs"]
mod player;
#[cfg(windows)]
#[path = "mpv_windows.rs"]
mod player;

/// What the page hears about. Time is sent at most every TIME_STEP and the page counts on between; everything else
/// is sent as it changes.
const OBSERVED: &[&str] = &[
    "time-pos",
    "pause",
    "duration",
    "paused-for-cache",
    "seeking",
    "eof-reached",
    "volume",
    "mute",
    "speed",
    "demuxer-cache-time",
    "width",
    "height",
    // What's really playing, for checking quality (scripts/e2e-desktop-quality.ts) and in DevTools: the decoder in
    // use, the file's picture (size, colours, Dolby Vision) and what reaches the screen, and frames dropped.
    "hwdec-current",
    "video-params",
    "frame-drop-count",
    "decoder-frame-drop-count",
];
const TIME_STEP: Duration = Duration::from_millis(250);
/// Properties the page may set. Anything else (mpv can run programs) stays out of the site's reach. panscan,
/// keepaspect and video-unscaled are the player's Picture menu: crop, stretch and original size. The file's own
/// video-crop trims black bars built into the film, and mpv drops it when the file ends. deband is the Picture setting.
/// sub-margin-y lifts the file's own subtitles above the controls while they show.
const SETTABLE: &[&str] = &[
    "pause",
    "speed",
    "volume",
    "mute",
    "aid",
    "sid",
    "sub-delay",
    "panscan",
    "keepaspect",
    "video-unscaled",
    "file-local-options/video-crop",
    "deband",
    "sub-margin-y",
];

static GENERATION: AtomicU32 = AtomicU32::new(0);
static LOOKING: AtomicBool = AtomicBool::new(false);

#[derive(Default)]
pub struct Mpv(Mutex<Option<Running>>);

struct Running {
    generation: u32,
    player: player::Player,
    tx: mpsc::UnboundedSender<Value>,
    pipe: String,
}

impl Mpv {
    /// The running player's command line, starting mpv first if it isn't running.
    fn ensure(&self, app: &AppHandle) -> Result<mpsc::UnboundedSender<Value>, String> {
        let mut slot = self.0.lock().unwrap();
        if let Some(running) = slot.as_mut() {
            if running.player.running() {
                return Ok(running.tx.clone());
            }
        }
        let running = spawn(app)?;
        let tx = running.tx.clone();
        *slot = Some(running);
        Ok(tx)
    }

    fn send(&self, command: Value) {
        if let Some(running) = self.0.lock().unwrap().as_ref() {
            let _ = running.tx.send(command);
        }
    }

    /// The running player's pipe, for asking it something on a line of its own.
    fn pipe(&self) -> Option<String> {
        self.0.lock().unwrap().as_ref().map(|r| r.pipe.clone())
    }

    /// Forgets a player that has gone, unless a newer one has replaced it meanwhile.
    fn gone(&self, generation: u32) {
        let mut slot = self.0.lock().unwrap();
        if slot.as_ref().is_some_and(|r| r.generation == generation) {
            *slot = None;
        }
    }

    pub fn kill(&self) {
        if let Some(mut running) = self.0.lock().unwrap().take() {
            running.player.kill();
        }
    }
}

/// Keeps mpv's picture under the page as the app's window changes size.
pub fn window_changed(app: &AppHandle) {
    player::follow(app);
}

/// Whether mpv has started since the app opened: something has played (update.rs waits for nothing to have).
pub fn started() -> bool {
    GENERATION.load(Ordering::SeqCst) > 0
}

fn spawn(app: &AppHandle) -> Result<Running, String> {
    let window = player::window(app)?;
    let generation = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    let pipe = player::ipc_path(generation);
    // KRIDA_SILENT=1 (tests) plays with no sound device at all, so a test run never makes a noise.
    let silent = std::env::var("KRIDA_SILENT").is_ok_and(|v| v == "1");
    // libplacebo compiles its shaders for each new mpv, about half a second before the first picture (more for HDR).
    // Kept on disk, a later start reads them back; without --config, mpv has no folder of its own to keep them in.
    let shaders = app.path().app_cache_dir().map(|dir| dir.join("mpv-shaders")).ok().filter(|dir| std::fs::create_dir_all(dir).is_ok());
    let args = silent
        .then(|| "--ao=null".to_string())
        .into_iter()
        .chain(shaders.map(|dir| format!("--gpu-shader-cache-dir={}", dir.display())))
        .chain([
            format!("--input-ipc-server={pipe}"),
            // Only what the app asks for: no mpv.conf, scripts, on-screen controller or key bindings of its own.
            "--config=no".into(),
            "--load-scripts=no".into(),
            "--terminal=no".into(),
            "--osc=no".into(),
            "--osd-level=0".into(),
            "--input-default-bindings=no".into(),
            "--input-vo-keyboard=no".into(),
            "--input-cursor=no".into(),
            "--cursor-autohide=no".into(),
            "--ytdl=no".into(),
            // Idle between titles, as a black window under the page, ready for the next one.
            "--idle=yes".into(),
            "--force-window=yes".into(),
            "--keep-open=yes".into(),
            "--pause".into(),
            // The GPU decodes; libplacebo renders, tone-mapping HDR for an SDR screen and passing it to an HDR one.
            "--vo=gpu-next".into(),
            "--hwdec=auto-safe".into(),
            "--target-colorspace-hint=auto".into(),
            // mpv otherwise assumes an SDR screen is 1000:1 and raises everything near black to meet that black, three
            // times the light the film holds on an OLED. An LCD's own glow adds its black either way.
            "--target-contrast=inf".into(),
            // Sharper than mpv's default when a film is smaller than the screen (1080p on a 1440p one), as Nuvio and
            // Stremio Kai scale, and deband evens out the stepped colour compression leaves in skies and dark scenes.
            // The page turns deband off when the Picture setting is off.
            "--scale=spline36".into(),
            "--cscale=spline36".into(),
            "--deband=yes".into(),
            // Subtitles start off: the page turns on one of the file's own tracks (`sid`), or draws OpenSubtitles itself.
            "--sid=no".into(),
            "--sub-auto=no".into(),
            "--audio-display=no".into(),
            // Windows' media controls would pause mpv behind the party's back; the page owns play and pause.
            "--media-controls=no".into(),
            "--cache=yes".into(),
            // Read ahead about 25 s of an 80 Mbps 4K remux, 50 s of a typical 4K film: plenty from a fast CDN, and
            // half the memory of mpv's 512 MB default on a laptop that's short of it.
            "--demuxer-max-bytes=256MiB".into(),
            "--demuxer-max-back-bytes=64MiB".into(),
            "--demuxer-readahead-secs=120".into(),
            "--network-timeout=30".into(),
            // TorBox answers 429 for a while after many reads of one file, and drops a connection now and then. mpv
            // alone tries a few times at once and then ends the film; ffmpeg's reconnect keeps trying, waiting longer
            // each time, for about a minute (reconnect_delay_max), while the player shows it's buffering.
            "--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_on_network_error=1,reconnect_delay_max=60,reconnect_on_http_error=[429,5xx]".into(),
        ])
        .collect();
    let player = player::Player::start(app, window, args)?;
    let (tx, rx) = mpsc::unbounded_channel();
    tauri::async_runtime::spawn(pump(app.clone(), pipe.clone(), rx, window, generation));
    Ok(Running { generation, player, tx, pipe })
}

/// Connects to mpv's pipe and passes messages both ways until mpv exits.
async fn pump(app: AppHandle, pipe: String, mut rx: mpsc::UnboundedReceiver<Value>, window: isize, generation: u32) {
    let mut client = None;
    for _ in 0..200 {
        match player::connect(&pipe).await {
            Ok(c) => {
                client = Some(c);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
    let Some(client) = client else {
        let _ = app.emit("mpv", json!({ "event": "exit", "error": "mpv didn't start" }));
        app.state::<Mpv>().gone(generation);
        return;
    };
    for _ in 0..80 {
        if player::sink(&app, window) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    let (read, mut write) = tokio::io::split(client);
    let observe = OBSERVED
        .iter()
        .enumerate()
        .map(|(i, name)| json!({ "command": ["observe_property", i + 1, name] }));
    tauri::async_runtime::spawn(async move {
        for line in observe {
            if write.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                return;
            }
        }
        while let Some(command) = rx.recv().await {
            let line = format!("{}\n", json!({ "command": command }));
            if write.write_all(line.as_bytes()).await.is_err() {
                return;
            }
        }
    });

    let mut lines = BufReader::new(read).lines();
    let mut time = Value::Null;
    let mut time_sent = Value::Null;
    let mut tick = tokio::time::interval(TIME_STEP);
    loop {
        tokio::select! {
            line = lines.next_line() => {
                let Ok(Some(line)) = line else { break };
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                match message.get("event").and_then(Value::as_str) {
                    Some("property-change") => {
                        let name = message["name"].as_str().unwrap_or_default();
                        if name == "time-pos" {
                            time = message["data"].clone();
                            continue;
                        }
                        time_sent = time.clone();
                        let _ = app.emit("mpv", json!({ "name": name, "value": message["data"], "time": time }));
                    }
                    Some(event @ ("file-loaded" | "seek" | "playback-restart" | "end-file")) => {
                        time_sent = time.clone();
                        let _ = app.emit("mpv", json!({ "event": event, "reason": message["reason"], "error": message["file_error"], "time": time }));
                    }
                    _ => {}
                }
            }
            _ = tick.tick() => {
                if time != time_sent {
                    time_sent = time.clone();
                    let _ = app.emit("mpv", json!({ "name": "time-pos", "value": time, "time": time }));
                }
            }
        }
    }
    let _ = app.emit("mpv", json!({ "event": "exit" }));
    app.state::<Mpv>().gone(generation);
}

fn playable(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|_| "not a link".to_string())?;
    match parsed.scheme() {
        "http" | "https" => Ok(()),
        _ => Err("only web links play".into()),
    }
}

/// Plays `url` from `start` seconds, paused or not, on audio track `aid` (mpv counts from 1).
#[tauri::command]
pub fn mpv_load(
    app: AppHandle,
    mpv: State<Mpv>,
    url: String,
    start: f64,
    paused: bool,
    aid: Option<u32>,
    title: Option<String>,
) -> Result<(), String> {
    playable(&url)?;
    let tx = mpv.ensure(&app)?;
    let send = |command: Value| tx.send(command).map_err(|_| "mpv has stopped".to_string());
    send(json!(["set_property", "force-media-title", title.unwrap_or_default()]))?;
    send(json!(["set_property", "pause", paused]))?;
    let aid = aid.map_or("auto".to_string(), |a| a.to_string());
    send(json!(["loadfile", url, "replace", -1, format!("start={:.3},aid={aid}", start.max(0.0))]))
}

/// Starts mpv, idle under the page, if it isn't running: the player asks as it opens, so mpv is ready by the time the
/// file's link arrives instead of starting after it.
#[tauri::command]
pub fn mpv_warm(app: AppHandle, mpv: State<Mpv>) -> Result<(), String> {
    mpv.ensure(&app).map(|_| ())
}

#[tauri::command]
pub fn mpv_seek(mpv: State<Mpv>, time: f64) {
    mpv.send(json!(["seek", time.max(0.0), "absolute"]));
}

#[tauri::command]
pub fn mpv_set(mpv: State<Mpv>, name: String, value: Value) -> Result<(), String> {
    if !SETTABLE.contains(&name.as_str()) {
        return Err(format!("{name} can't be set"));
    }
    mpv.send(json!(["set_property", name, value]));
    Ok(())
}

/// Stops playing and leaves mpv idle, a black window under the page.
#[tauri::command]
pub fn mpv_stop(mpv: State<Mpv>) {
    mpv.send(json!(["stop"]));
}

/// How lit each row and column of the frame showing now is, for finding black bars built into the film
/// (src/features/player/bars.ts in the site). It reads mpv's own picture of the decoded frame, without subtitles; once
/// video-crop is set that picture is cropped too, so the site looks only before it trims. mpv's cropdetect filter
/// can't do this here: it refuses frames the GPU decoded, and decoding a 4K film without the GPU to feed it would stutter.
#[tauri::command]
pub async fn mpv_frame_light(mpv: State<'_, Mpv>, level: u8) -> Result<FrameLight, String> {
    let pipe = mpv.pipe().ok_or("mpv isn't running")?;
    // One look at a time, whatever the page asks: mpv takes the picture while playback waits, and an install doesn't
    // update itself, so this can't rely on the site. It also means one file per run: a look that times out before mpv
    // writes its picture leaves it for the next look to replace, not a new file each time.
    if LOOKING.swap(true, Ordering::AcqRel) {
        return Err("already looking".into());
    }
    let _looking = Looking;
    let file = std::env::temp_dir().join(format!("krida-frame-{}.jpg", std::process::id()));
    let taken = ask(&pipe, json!(["screenshot-to-file", file.to_string_lossy(), "video"])).await;
    tauri::async_runtime::spawn_blocking(move || {
        let jpeg = taken.and_then(|_| std::fs::read(&file).map_err(|e| e.to_string()));
        let _ = std::fs::remove_file(&file);
        frame_light(&jpeg?, level)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Lets the next look start when this one ends, however it ends.
struct Looking;

impl Drop for Looking {
    fn drop(&mut self) {
        LOOKING.store(false, Ordering::Release);
    }
}

/// Sends mpv one command on a line of its own (it takes several at once) and waits for the answer.
async fn ask(pipe: &str, command: Value) -> Result<Value, String> {
    let mut client = None;
    for _ in 0..40 {
        match player::connect(pipe).await {
            Ok(c) => {
                client = Some(c);
                break;
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(25)).await,
        }
    }
    let (read, mut write) = tokio::io::split(client.ok_or("mpv's pipe didn't answer")?);
    let line = format!("{}\n", json!({ "command": command, "request_id": 1 }));
    write.write_all(line.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut lines = BufReader::new(read).lines();
    // Other lines are mpv's events, which every line it serves hears.
    let answer = tokio::time::timeout(Duration::from_secs(5), async {
        while let Ok(Some(line)) = lines.next_line().await {
            let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
            if message["request_id"] == 1 {
                return Some(message);
            }
        }
        None
    })
    .await
    .map_err(|_| "mpv didn't answer in time".to_string())?
    .ok_or("mpv closed the pipe")?;
    match answer["error"].as_str() {
        Some("success") => Ok(answer["data"].clone()),
        error => Err(error.unwrap_or("mpv refused").to_string()),
    }
}

/// A frame's light: for each row from the top, then each column from the left, the share of its pixels brighter
/// than the level asked for, to a thousandth.
#[derive(serde::Serialize)]
pub struct FrameLight {
    width: usize,
    height: usize,
    rows: Vec<f32>,
    cols: Vec<f32>,
}

fn frame_light(jpeg: &[u8], level: u8) -> Result<FrameLight, String> {
    let mut decoder = jpeg_decoder::Decoder::new(jpeg);
    decoder.read_info().map_err(|e| e.to_string())?;
    // Read at about 960x540: a quarter of a 4K frame each way, which still places a bar's edge to within 4 of its
    // pixels, and decodes a fraction of them.
    let (width, height) = decoder.scale(960, 540).map_err(|e| e.to_string())?;
    let (width, height) = (width as usize, height as usize);
    let pixels = decoder.decode().map_err(|e| e.to_string())?;
    let channels = match decoder.info().map(|i| i.pixel_format) {
        Some(jpeg_decoder::PixelFormat::L8) => 1,
        Some(jpeg_decoder::PixelFormat::RGB24) => 3,
        _ => return Err("mpv's picture isn't one this reads".into()),
    };
    if pixels.len() != width * height * channels {
        return Err("mpv's picture is the wrong size".into());
    }
    let mut rows = vec![0u32; height];
    let mut cols = vec![0u32; width];
    for (i, pixel) in pixels.chunks_exact(channels).enumerate() {
        // Luma, weighed as BT.709 does.
        let luma = match pixel {
            [r, g, b] => (54 * u32::from(*r) + 183 * u32::from(*g) + 19 * u32::from(*b)) >> 8,
            [l, ..] => u32::from(*l),
            [] => 0,
        };
        if luma > u32::from(level) {
            rows[i / width] += 1;
            cols[i % width] += 1;
        }
    }
    let share = |lit: u32, of: usize| (lit as f32 / of as f32 * 1000.0).round() / 1000.0;
    Ok(FrameLight {
        width,
        height,
        rows: rows.into_iter().map(|lit| share(lit, width)).collect(),
        cols: cols.into_iter().map(|lit| share(lit, height)).collect(),
    })
}
