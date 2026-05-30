use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use tauri::{AppHandle, Emitter};

static PTT_ACTIVE: AtomicBool = AtomicBool::new(false);
static PTT_VKEY: AtomicU32 = AtomicU32::new(0);

// ── Windows: GetAsyncKeyState ──────────────────────────────────────

#[cfg(target_os = "windows")]
extern "system" {
    fn GetAsyncKeyState(vKey: i32) -> i16;
}

#[cfg(target_os = "windows")]
fn code_to_platform_key(code: &str) -> Option<u32> {
    if code.starts_with("Key") && code.len() == 4 {
        let ch = code.as_bytes()[3];
        if ch.is_ascii_uppercase() { return Some(ch as u32) }
    }
    if code.starts_with("Digit") && code.len() == 6 {
        let ch = code.as_bytes()[5];
        if ch.is_ascii_digit() { return Some(ch as u32) }
    }
    if code.starts_with('F') && code.len() <= 3 {
        if let Ok(n) = code[1..].parse::<u32>() {
            if (1..=24).contains(&n) { return Some(0x6F + n) }
        }
    }
    match code {
        "Space" => Some(0x20), "Tab" => Some(0x09), "CapsLock" => Some(0x14),
        "ShiftLeft" | "ShiftRight" => Some(0x10),
        "ControlLeft" | "ControlRight" => Some(0x11),
        "AltLeft" | "AltRight" => Some(0x12),
        "Backquote" => Some(0xC0), "Minus" => Some(0xBD), "Equal" => Some(0xBB),
        "BracketLeft" => Some(0xDB), "BracketRight" => Some(0xDD),
        "Backslash" => Some(0xDC), "Semicolon" => Some(0xBA), "Quote" => Some(0xDE),
        "Comma" => Some(0xBC), "Period" => Some(0xBE), "Slash" => Some(0xBF),
        "Insert" => Some(0x2D), "Delete" => Some(0x2E),
        "Home" => Some(0x24), "End" => Some(0x23),
        "PageUp" => Some(0x21), "PageDown" => Some(0x22),
        "Escape" => Some(0x1B), "Enter" => Some(0x0D), "Backspace" => Some(0x08),
        "Numpad0" => Some(0x60), "Numpad1" => Some(0x61), "Numpad2" => Some(0x62),
        "Numpad3" => Some(0x63), "Numpad4" => Some(0x64), "Numpad5" => Some(0x65),
        "Numpad6" => Some(0x66), "Numpad7" => Some(0x67), "Numpad8" => Some(0x68),
        "Numpad9" => Some(0x69),
        "NumpadMultiply" => Some(0x6A), "NumpadAdd" => Some(0x6B),
        "NumpadSubtract" => Some(0x6D), "NumpadDecimal" => Some(0x6E),
        "NumpadDivide" => Some(0x6F),
        _ => None,
    }
}

#[cfg(target_os = "windows")]
fn run_ptt_loop(app: AppHandle, vkey: u32) {
    let mut was_pressed = false;
    tracing::info!("PTT watcher started (Windows) for vkey 0x{:02X}", vkey);
    while PTT_ACTIVE.load(Ordering::SeqCst) && PTT_VKEY.load(Ordering::SeqCst) == vkey {
        let pressed = unsafe { (GetAsyncKeyState(vkey as i32) as u16 & 0x8000) != 0 };
        if pressed != was_pressed {
            was_pressed = pressed;
            let _ = app.emit("ptt-state", pressed);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

// ── Linux: X11 XQueryKeymap ────────────────────────────────────────

// NOTE: On pure Wayland (no XWayland), global key state reading is not possible
// due to Wayland's security model. The PTT watcher will log a warning and the
// frontend falls back to in-window keydown/keyup listeners (focus-only PTT).
// Most Linux desktops still run XWayland, so this covers the majority of users.

#[cfg(target_os = "linux")]
mod x11 {
    use std::os::raw::{c_char, c_int, c_ulong};
    #[allow(non_camel_case_types)]
    pub type Display = *mut std::ffi::c_void;
    #[link(name = "X11")]
    extern "C" {
        pub fn XOpenDisplay(name: *const c_char) -> Display;
        pub fn XCloseDisplay(display: Display) -> c_int;
        pub fn XKeysymToKeycode(display: Display, keysym: c_ulong) -> u8;
        pub fn XQueryKeymap(display: Display, keys: *mut c_char);
    }
}

#[cfg(target_os = "linux")]
fn code_to_platform_key(code: &str) -> Option<u32> {
    // Returns X11 KeySym
    if code.starts_with("Key") && code.len() == 4 {
        let ch = code.as_bytes()[3];
        if ch.is_ascii_uppercase() { return Some(ch.to_ascii_lowercase() as u32) }
    }
    if code.starts_with("Digit") && code.len() == 6 {
        let ch = code.as_bytes()[5];
        if ch.is_ascii_digit() { return Some(ch as u32) }
    }
    if code.starts_with('F') && code.len() <= 3 {
        if let Ok(n) = code[1..].parse::<u32>() {
            if (1..=24).contains(&n) { return Some(0xffbd + n) }
        }
    }
    match code {
        "Space" => Some(0x0020), "Tab" => Some(0xff09), "CapsLock" => Some(0xffe5),
        "ShiftLeft" => Some(0xffe1), "ShiftRight" => Some(0xffe2),
        "ControlLeft" => Some(0xffe3), "ControlRight" => Some(0xffe4),
        "AltLeft" => Some(0xffe9), "AltRight" => Some(0xffea),
        "Backquote" => Some(0x0060), "Minus" => Some(0x002d), "Equal" => Some(0x003d),
        "BracketLeft" => Some(0x005b), "BracketRight" => Some(0x005d),
        "Backslash" => Some(0x005c), "Semicolon" => Some(0x003b), "Quote" => Some(0x0027),
        "Comma" => Some(0x002c), "Period" => Some(0x002e), "Slash" => Some(0x002f),
        "Insert" => Some(0xff63), "Delete" => Some(0xffff),
        "Home" => Some(0xff50), "End" => Some(0xff57),
        "PageUp" => Some(0xff55), "PageDown" => Some(0xff56),
        "Escape" => Some(0xff1b), "Enter" => Some(0xff0d), "Backspace" => Some(0xff08),
        _ => None,
    }
}

#[cfg(target_os = "linux")]
fn run_ptt_loop(app: AppHandle, keysym: u32) {
    let display = unsafe { x11::XOpenDisplay(std::ptr::null()) };
    if display.is_null() {
        tracing::warn!("PTT: cannot open X11 display (Wayland-only? PTT requires X11/XWayland)");
        return;
    }
    let keycode = unsafe { x11::XKeysymToKeycode(display, keysym as std::os::raw::c_ulong) };
    if keycode == 0 {
        tracing::warn!("PTT: X11 cannot map keysym 0x{:04X} to keycode", keysym);
        unsafe { x11::XCloseDisplay(display); }
        return;
    }

    let mut was_pressed = false;
    tracing::info!("PTT watcher started (Linux/X11) for keysym 0x{:04X} -> keycode {}", keysym, keycode);
    while PTT_ACTIVE.load(Ordering::SeqCst) && PTT_VKEY.load(Ordering::SeqCst) == keysym {
        let pressed = unsafe {
            let mut keymap: [std::os::raw::c_char; 32] = [0; 32];
            x11::XQueryKeymap(display, keymap.as_mut_ptr());
            let byte = keycode / 8;
            let bit = keycode % 8;
            (byte < 32) && ((keymap[byte as usize] >> bit) & 1 != 0)
        };
        if pressed != was_pressed {
            was_pressed = pressed;
            let _ = app.emit("ptt-state", pressed);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    unsafe { x11::XCloseDisplay(display); }
}

// ── macOS: CGEventSourceKeyState ───────────────────────────────────

#[cfg(target_os = "macos")]
extern "C" {
    fn CGEventSourceKeyState(stateID: i32, key: u16) -> bool;
}

#[cfg(target_os = "macos")]
fn code_to_platform_key(code: &str) -> Option<u32> {
    // Returns macOS virtual key code
    if code.starts_with("Key") && code.len() == 4 {
        let ch = code.as_bytes()[3];
        return match ch {
            b'A' => Some(0x00), b'B' => Some(0x0B), b'C' => Some(0x08), b'D' => Some(0x02),
            b'E' => Some(0x0E), b'F' => Some(0x03), b'G' => Some(0x05), b'H' => Some(0x04),
            b'I' => Some(0x22), b'J' => Some(0x26), b'K' => Some(0x28), b'L' => Some(0x25),
            b'M' => Some(0x2E), b'N' => Some(0x2D), b'O' => Some(0x1F), b'P' => Some(0x23),
            b'Q' => Some(0x0C), b'R' => Some(0x0F), b'S' => Some(0x01), b'T' => Some(0x11),
            b'U' => Some(0x20), b'V' => Some(0x09), b'W' => Some(0x0D), b'X' => Some(0x07),
            b'Y' => Some(0x10), b'Z' => Some(0x06),
            _ => None,
        };
    }
    if code.starts_with("Digit") && code.len() == 6 {
        let ch = code.as_bytes()[5];
        return match ch {
            b'0' => Some(0x1D), b'1' => Some(0x12), b'2' => Some(0x13), b'3' => Some(0x14),
            b'4' => Some(0x15), b'5' => Some(0x17), b'6' => Some(0x16), b'7' => Some(0x1A),
            b'8' => Some(0x1C), b'9' => Some(0x19),
            _ => None,
        };
    }
    if code.starts_with('F') && code.len() <= 3 {
        if let Ok(n) = code[1..].parse::<u32>() {
            return match n {
                1 => Some(0x7A), 2 => Some(0x78), 3 => Some(0x63), 4 => Some(0x76),
                5 => Some(0x60), 6 => Some(0x61), 7 => Some(0x62), 8 => Some(0x64),
                9 => Some(0x65), 10 => Some(0x6D), 11 => Some(0x67), 12 => Some(0x6F),
                _ => None,
            };
        }
    }
    match code {
        "Space" => Some(0x31), "Tab" => Some(0x30), "CapsLock" => Some(0x39),
        "ShiftLeft" => Some(0x38), "ShiftRight" => Some(0x3C),
        "ControlLeft" => Some(0x3B), "ControlRight" => Some(0x3E),
        "AltLeft" => Some(0x3A), "AltRight" => Some(0x3D),
        "Backquote" => Some(0x32), "Minus" => Some(0x1B), "Equal" => Some(0x18),
        "BracketLeft" => Some(0x21), "BracketRight" => Some(0x1E),
        "Backslash" => Some(0x2A), "Semicolon" => Some(0x29), "Quote" => Some(0x27),
        "Comma" => Some(0x2B), "Period" => Some(0x2F), "Slash" => Some(0x2C),
        "Delete" => Some(0x75), "Home" => Some(0x73), "End" => Some(0x77),
        "PageUp" => Some(0x74), "PageDown" => Some(0x79),
        "Escape" => Some(0x35), "Enter" => Some(0x24), "Backspace" => Some(0x33),
        _ => None,
    }
}

#[cfg(target_os = "macos")]
fn run_ptt_loop(app: AppHandle, vkey: u32) {
    let mut was_pressed = false;
    tracing::info!("PTT watcher started (macOS) for vkey 0x{:02X}", vkey);
    while PTT_ACTIVE.load(Ordering::SeqCst) && PTT_VKEY.load(Ordering::SeqCst) == vkey {
        // kCGEventSourceStateHIDSystemState = 1
        let pressed = unsafe { CGEventSourceKeyState(1, vkey as u16) };
        if pressed != was_pressed {
            was_pressed = pressed;
            let _ = app.emit("ptt-state", pressed);
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}

// ── Commands ───────────────────────────────────────────────────────

#[tauri::command]
pub fn start_ptt_watch(app: AppHandle, key_code: String) {
    PTT_ACTIVE.store(false, Ordering::SeqCst);
    std::thread::sleep(std::time::Duration::from_millis(30));

    let vkey = match code_to_platform_key(&key_code) {
        Some(k) => k,
        None => {
            tracing::warn!("PTT: cannot map '{}' to platform key", key_code);
            return;
        }
    };

    PTT_VKEY.store(vkey, Ordering::SeqCst);
    PTT_ACTIVE.store(true, Ordering::SeqCst);

    std::thread::spawn(move || {
        run_ptt_loop(app, vkey);
        tracing::info!("PTT watcher stopped");
    });
}

#[tauri::command]
pub fn stop_ptt_watch() {
    PTT_ACTIVE.store(false, Ordering::SeqCst);
}
