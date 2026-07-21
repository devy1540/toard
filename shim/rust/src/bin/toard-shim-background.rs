#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::{Path, PathBuf};

#[cfg_attr(not(windows), allow(dead_code))]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, PartialEq, Eq)]
#[cfg_attr(not(windows), allow(dead_code))]
struct LaunchSpec {
    executable: PathBuf,
    args: [&'static str; 2],
    creation_flags: u32,
}

#[cfg_attr(not(windows), allow(dead_code))]
fn launch_spec(current_exe: &Path) -> Result<LaunchSpec, &'static str> {
    let executable = current_exe
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.join("toard-shim.exe"))
        .or_else(|| {
            current_exe
                .to_str()?
                .rsplit_once('\\')
                .filter(|(parent, _)| !parent.is_empty())
                .map(|(parent, _)| PathBuf::from(format!("{parent}\\toard-shim.exe")))
        })
        .ok_or("helper parent directory is missing")?;
    Ok(LaunchSpec {
        executable,
        args: ["collect", "--quiet"],
        creation_flags: CREATE_NO_WINDOW,
    })
}

#[cfg(windows)]
fn run() -> i32 {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};

    let current = match std::env::current_exe() {
        Ok(path) => path,
        Err(_) => return 1,
    };
    let spec = match launch_spec(&current) {
        Ok(spec) => spec,
        Err(_) => return 1,
    };
    match Command::new(spec.executable)
        .args(spec.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(spec.creation_flags)
        .status()
    {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 1,
    }
}

#[cfg(not(windows))]
fn run() -> i32 {
    1
}

fn main() {
    std::process::exit(run());
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launches_sibling_shim_without_a_console() {
        let spec = launch_spec(Path::new(
            r"C:\Users\GA\.toard\bin\toard-shim-background.exe",
        ))
        .expect("valid helper path");

        assert_eq!(
            spec.executable,
            PathBuf::from(r"C:\Users\GA\.toard\bin\toard-shim.exe")
        );
        assert_eq!(spec.args, ["collect", "--quiet"]);
        assert_eq!(spec.creation_flags, CREATE_NO_WINDOW);
    }

    #[test]
    fn refuses_a_path_without_a_parent() {
        assert_eq!(
            launch_spec(Path::new("")),
            Err("helper parent directory is missing")
        );
    }
}
