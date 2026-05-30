// Prevents an additional console window on Windows in release builds.
// DO NOT REMOVE — this is required for production.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    den_chat_lib::run()
}
