//! Packing a folder app and running it from one file.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use collabdoc_launcher::{APP, Payload, pack};

/// A fresh folder for one test.
fn scratch(name: &str) -> PathBuf {
    let dir =
        std::env::temp_dir().join(format!("collabdoc-launcher-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// A bundle shaped like Flutter's, whose app prints its arguments.
fn bundle(root: &Path, version: &str) -> PathBuf {
    let dir = root.join(format!("bundle-{version}"));
    fs::create_dir_all(dir.join("lib")).unwrap();
    fs::create_dir_all(dir.join("data/flutter_assets")).unwrap();
    fs::write(dir.join(APP), format!("#!/bin/sh\necho \"{version} $*\"\n")).unwrap();
    fs::write(dir.join("lib/libapp.so"), vec![7u8; 100_000]).unwrap();
    fs::write(dir.join("data/flutter_assets/AssetManifest.bin"), b"assets").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir.join(APP), fs::Permissions::from_mode(0o755)).unwrap();
    }
    dir
}

#[test]
fn a_packed_file_unpacks_once_with_contents_and_modes() {
    let root = scratch("unpack");
    let src = bundle(&root, "v1");
    let out = root.join("packed");
    let payload = pack(&src, b"STUB", &out).unwrap();
    assert_eq!(Payload::find(&out).unwrap(), Some(payload));
    assert!(fs::metadata(&out).unwrap().len() < 100_000, "compressed");

    let cache = root.join("cache");
    let dir = payload.install(&out, &cache).unwrap();
    assert_eq!(dir, payload.dir(&cache));
    assert_eq!(
        fs::read(dir.join("lib/libapp.so")).unwrap(),
        vec![7u8; 100_000]
    );
    assert_eq!(
        fs::read(dir.join("data/flutter_assets/AssetManifest.bin")).unwrap(),
        b"assets"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::metadata(dir.join(APP)).unwrap().permissions().mode();
        assert_eq!(mode & 0o111, 0o111, "the app stays executable");
    }

    // The second run uses what is there.
    fs::write(dir.join("marker"), b"").unwrap();
    assert_eq!(payload.install(&out, &cache).unwrap(), dir);
    assert!(dir.join("marker").exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_new_version_replaces_the_old_one_in_the_cache() {
    let root = scratch("versions");
    let cache = root.join("cache");
    let old = pack(&bundle(&root, "v1"), b"STUB", &root.join("v1")).unwrap();
    let new = pack(&bundle(&root, "v2"), b"STUB", &root.join("v2")).unwrap();
    assert_ne!(old.hash, new.hash);
    old.install(&root.join("v1"), &cache).unwrap();
    new.install(&root.join("v2"), &cache).unwrap();
    assert!(!old.dir(&cache).exists());
    assert!(new.dir(&cache).exists());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn a_damaged_file_is_refused_and_leaves_nothing_behind() {
    let root = scratch("damaged");
    let out = root.join("packed");
    let payload = pack(&bundle(&root, "v1"), b"STUB", &out).unwrap();
    let mut bytes = fs::read(&out).unwrap();
    bytes[10] ^= 0xff; // inside the payload, after the 4-byte stub
    fs::write(&out, bytes).unwrap();
    let cache = root.join("cache");
    let err = payload.install(&out, &cache).unwrap_err();
    assert!(err.to_string().contains("damaged"), "{err}");
    assert_eq!(
        fs::read_dir(cache.join("collabdoc/app"))
            .map(|d| d.count())
            .unwrap_or(0),
        0
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn plain_files_and_folders_without_the_app_are_not_payloads() {
    let root = scratch("plain");
    fs::write(root.join("tiny"), b"x").unwrap();
    assert_eq!(Payload::find(&root.join("tiny")).unwrap(), None);
    fs::write(root.join("program"), vec![1u8; 4096]).unwrap();
    assert_eq!(Payload::find(&root.join("program")).unwrap(), None);
    fs::create_dir_all(root.join("empty")).unwrap();
    assert!(pack(&root.join("empty"), b"STUB", &root.join("out")).is_err());
    fs::remove_dir_all(root).unwrap();
}

#[cfg(unix)]
#[test]
fn the_packed_file_runs_the_app_with_its_arguments() {
    let root = scratch("run");
    let launcher = env!("CARGO_BIN_EXE_collabdoc-launcher");
    let packed = root.join("collabdoc-onefile");
    let status = Command::new(launcher)
        .arg(bundle(&root, "v1"))
        .arg(&packed)
        .status()
        .unwrap();
    assert!(status.success());

    let run = |args: &[&str]| {
        let out = Command::new(&packed)
            .args(args)
            .env("XDG_CACHE_HOME", root.join("cache"))
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        String::from_utf8(out.stdout).unwrap()
    };
    assert_eq!(run(&["notes.collabdoc"]), "v1 notes.collabdoc\n");
    // Arguments that look like the packer's go to the app, too.
    assert_eq!(run(&["--stub", "x"]), "v1 --stub x\n");

    // A packed file is not a stub for another.
    let again = Command::new(launcher)
        .arg(bundle(&root, "v2"))
        .arg(root.join("twice"))
        .arg("--stub")
        .arg(&packed)
        .output()
        .unwrap();
    assert!(!again.status.success());
    fs::remove_dir_all(root).unwrap();
}
