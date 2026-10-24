// Bez konzolového okna v release builde na Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if project_desk_lib::hook_relay::run_if_requested() { return; }
    project_desk_lib::run()
}
