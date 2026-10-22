// Bez konzolového okna v release builde na Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    project_desk_lib::run()
}
