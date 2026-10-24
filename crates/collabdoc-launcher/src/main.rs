//! `collabdoc-launcher <bundle-dir> <out> [--stub <launcher>]` packs a folder
//! app into one executable. The packed file, run, starts the app with the
//! arguments it was given (see the library docs).
//!
//! `--stub` packs with another build of this launcher, e.g. the Windows one
//! when packing on Linux.

#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::process::ExitCode;

use collabdoc_launcher::{Payload, cache_root, pack};

fn main() -> ExitCode {
    let result = std::env::current_exe().and_then(|exe| match Payload::find(&exe)? {
        // A packed app: every argument is the app's.
        Some(payload) => run(&exe, payload),
        None => pack_command(&exe),
    });
    match result {
        Ok(code) => code,
        Err(err) => {
            eprintln!("collabdoc: {err}");
            ExitCode::FAILURE
        }
    }
}

fn run(exe: &Path, payload: Payload) -> std::io::Result<ExitCode> {
    let cache =
        cache_root().ok_or_else(|| std::io::Error::other("no cache folder (HOME unset)"))?;
    let dir = payload.install(exe, &cache)?;
    let mut app = std::process::Command::new(dir.join(collabdoc_launcher::APP));
    app.args(std::env::args_os().skip(1));
    #[cfg(unix)]
    {
        // Become the app: no second process, nothing left running.
        use std::os::unix::process::CommandExt;
        Err(app.exec())
    }
    #[cfg(not(unix))]
    {
        // Windows cannot replace a process; start the app and leave.
        app.spawn()?;
        Ok(ExitCode::SUCCESS)
    }
}

fn pack_command(exe: &Path) -> std::io::Result<ExitCode> {
    let mut args = std::env::args_os().skip(1);
    let mut positional = Vec::new();
    let mut stub = exe.to_path_buf();
    while let Some(arg) = args.next() {
        if arg == "--stub" {
            stub = PathBuf::from(
                args.next()
                    .ok_or_else(|| std::io::Error::other("--stub needs a path"))?,
            );
        } else {
            positional.push(PathBuf::from(arg));
        }
    }
    let [bundle, out] = positional.as_slice() else {
        eprintln!("usage: collabdoc-launcher <bundle-dir> <out> [--stub <launcher>]");
        return Ok(ExitCode::from(2));
    };
    let stub_bytes = std::fs::read(&stub)?;
    if Payload::find(&stub)?.is_some() {
        return Err(std::io::Error::other("the stub is already a packed app"));
    }
    let payload = pack(bundle, &stub_bytes, out)?;
    println!(
        "{} → {} ({:.1} MB, app {:.1} MB compressed)",
        bundle.display(),
        out.display(),
        (stub_bytes.len() as u64 + payload.len) as f64 / 1e6,
        payload.len as f64 / 1e6,
    );
    Ok(ExitCode::SUCCESS)
}
