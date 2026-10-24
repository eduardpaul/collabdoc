//! One-file distribution for an app that is a folder (Flutter's bundle:
//! executable, engine library, AOT code, assets).
//!
//! A packed file is this launcher's executable with the folder appended as a
//! zstd-compressed tar and a footer: `[payload length u64][hash u64][MAGIC]`.
//! On first run the payload is checked, unpacked to a temporary folder in the
//! user cache and renamed into place under its hash, so a half-written copy is
//! never used and two instances starting at once cannot clash. Later runs find
//! the folder and start the app straight away. Older versions are removed.

use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

pub const MAGIC: &[u8; 8] = b"CDBUNDLE";
const FOOTER: u64 = 24;

/// The app's executable inside the folder.
pub const APP: &str = if cfg!(windows) {
    "collabdoc.exe"
} else {
    "collabdoc"
};

/// What a packed file carries after its launcher.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Payload {
    pub len: u64,
    pub hash: u64,
}

impl Payload {
    /// The payload appended to `exe`, if there is one.
    pub fn find(exe: &Path) -> io::Result<Option<Payload>> {
        let mut file = File::open(exe)?;
        if file.metadata()?.len() < FOOTER {
            return Ok(None);
        }
        let mut footer = [0u8; FOOTER as usize];
        file.seek(SeekFrom::End(-(FOOTER as i64)))?;
        file.read_exact(&mut footer)?;
        if &footer[16..] != MAGIC {
            return Ok(None);
        }
        let word = |i: usize| u64::from_le_bytes(footer[i..i + 8].try_into().unwrap());
        Ok(Some(Payload {
            len: word(0),
            hash: word(8),
        }))
    }

    /// Where this version lives under `cache` (e.g. `~/.cache`).
    pub fn dir(&self, cache: &Path) -> PathBuf {
        versions(cache).join(format!("{:016x}", self.hash))
    }

    /// Unpacks the app from `exe` into `cache` unless it is already there;
    /// returns its folder.
    pub fn install(&self, exe: &Path, cache: &Path) -> io::Result<PathBuf> {
        let dir = self.dir(cache);
        if dir.is_dir() {
            return Ok(dir);
        }
        let mut file = File::open(exe)?;
        let end = file.metadata()?.len();
        let start = end
            .checked_sub(FOOTER + self.len)
            .ok_or_else(|| invalid("payload longer than the file"))?;
        file.seek(SeekFrom::Start(start))?;
        let mut packed = vec![0; self.len as usize];
        file.read_exact(&mut packed)?;
        if fnv1a(&packed) != self.hash {
            return Err(invalid("the app inside this file is damaged"));
        }
        fs::create_dir_all(versions(cache))?;
        let tmp = dir.with_extension(format!("tmp{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let unpacked = tar::Archive::new(zstd::Decoder::new(&packed[..])?).unpack(&tmp);
        if let Err(err) = unpacked {
            let _ = fs::remove_dir_all(&tmp);
            return Err(err);
        }
        // Another instance may have finished first; either copy is the same.
        if fs::rename(&tmp, &dir).is_err() {
            let _ = fs::remove_dir_all(&tmp);
            if !dir.is_dir() {
                return Err(io::Error::other("could not move the app into place"));
            }
        }
        self.prune(cache);
        Ok(dir)
    }

    /// Removes other versions. A copy still in use stays where the platform
    /// will not delete open files (Windows); Unix keeps open files alive.
    fn prune(&self, cache: &Path) {
        let Ok(entries) = fs::read_dir(versions(cache)) else {
            return;
        };
        let keep = format!("{:016x}", self.hash);
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let version = name.len() == 16 && name.chars().all(|c| c.is_ascii_hexdigit());
            if version && name != keep {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
}

/// Writes `stub` (a launcher executable) followed by `bundle` packed.
pub fn pack(bundle: &Path, stub: &[u8], out: &Path) -> io::Result<Payload> {
    if !bundle.join(APP).is_file() && !bundle.join("collabdoc.exe").is_file() {
        return Err(invalid("no collabdoc executable in the bundle folder"));
    }
    let mut tar = tar::Builder::new(Vec::new());
    tar.follow_symlinks(false);
    tar.append_dir_all(".", bundle)?;
    let packed = zstd::encode_all(&tar.into_inner()?[..], 19)?;
    let payload = Payload {
        len: packed.len() as u64,
        hash: fnv1a(&packed),
    };
    let mut file = File::create(out)?;
    file.write_all(stub)?;
    file.write_all(&packed)?;
    file.write_all(&payload.len.to_le_bytes())?;
    file.write_all(&payload.hash.to_le_bytes())?;
    file.write_all(MAGIC)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(out, fs::Permissions::from_mode(0o755))?;
    }
    Ok(payload)
}

/// The user's cache folder: `%LOCALAPPDATA%`, else `$XDG_CACHE_HOME` or
/// `~/.cache` (macOS included, which keeps it simple).
pub fn cache_root() -> Option<PathBuf> {
    let var = |key| {
        std::env::var_os(key)
            .filter(|v| !v.is_empty())
            .map(PathBuf::from)
    };
    if cfg!(windows) {
        return var("LOCALAPPDATA");
    }
    var("XDG_CACHE_HOME").or_else(|| var("HOME").map(|home| home.join(".cache")))
}

fn versions(cache: &Path) -> PathBuf {
    cache.join("collabdoc").join("app")
}

/// FNV-1a: stable across builds and platforms, so one file always maps to
/// one cache folder.
fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325, |h, b| {
        (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
    })
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
