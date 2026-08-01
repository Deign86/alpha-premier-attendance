use std::{sync::{Arc, Mutex}, time::{Duration, Instant}};

fn key_text(key: rdev::Key) -> Option<char> {
    use rdev::Key::*;
    match key { Num0|Kp0 => Some('0'), Num1|Kp1 => Some('1'), Num2|Kp2 => Some('2'), Num3|Kp3 => Some('3'), Num4|Kp4 => Some('4'), Num5|Kp5 => Some('5'), Num6|Kp6 => Some('6'), Num7|Kp7 => Some('7'), Num8|Kp8 => Some('8'), Num9|Kp9 => Some('9'), KeyA => Some('A'), KeyB => Some('B'), KeyC => Some('C'), KeyD => Some('D'), KeyE => Some('E'), KeyF => Some('F'), KeyG => Some('G'), KeyH => Some('H'), KeyI => Some('I'), KeyJ => Some('J'), KeyK => Some('K'), KeyL => Some('L'), KeyM => Some('M'), KeyN => Some('N'), KeyO => Some('O'), KeyP => Some('P'), KeyQ => Some('Q'), KeyR => Some('R'), KeyS => Some('S'), KeyT => Some('T'), KeyU => Some('U'), KeyV => Some('V'), KeyW => Some('W'), KeyX => Some('X'), KeyY => Some('Y'), KeyZ => Some('Z'), _ => None }
}

pub fn start(app: tauri::AppHandle) {
    let buffer = Arc::new(Mutex::new((String::new(), Instant::now())));
    let timer_buffer = Arc::clone(&buffer);
    let timer_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(25));
        let mut state = timer_buffer.lock().expect("RFID buffer lock");
        if !state.0.is_empty() && state.1.elapsed() >= Duration::from_millis(150) {
            let value = std::mem::take(&mut state.0);
            let _ = tauri::Emitter::emit(&timer_app, "rfid-scan", value);
        }
    });
    std::thread::spawn(move || {
        let result = rdev::listen(move |event| {
            let rdev::EventType::KeyPress(key) = event.event_type else { return; };
            let mut state = buffer.lock().expect("RFID buffer lock");
            if state.1.elapsed() > Duration::from_millis(150) { state.0.clear(); }
            state.1 = Instant::now();
            if matches!(key, rdev::Key::Return | rdev::Key::KpReturn) {
                if !state.0.is_empty() { let _ = tauri::Emitter::emit(&app, "rfid-scan", state.0.clone()); state.0.clear(); }
            } else if let Some(ch) = key_text(key) { state.0.push(ch); }
        });
        if let Err(error) = result { eprintln!("global RFID listener stopped: {error:?}"); }
    });
}
