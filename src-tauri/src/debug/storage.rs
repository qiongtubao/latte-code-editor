//! Filesystem maintenance for debug log directory.
//!
//! Three independent limits, applied in order:
//! 1. Age: anything older than `max_age_secs` is removed.
//! 2. Count: if more than `max_files` remain, drop oldest by mtime.
//! 3. Bytes: if total > `max_bytes_mb * 1_048_576`, drop oldest by mtime until ≤ half the cap (hysteresis).

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
struct Entry {
    path: PathBuf,
    size: u64,
    mtime: u64,
}

/// Remove debug log files per the configured limits.
///
/// Returns the number of files removed.
pub fn purge_old_logs(
    dir: &Path,
    max_age_secs: u64,
    max_bytes_mb: u64,
    max_files: usize,
) -> io::Result<usize> {
    if !dir.exists() {
        return Ok(0);
    }
    let mut entries = read_entries(dir)?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let mut removed = 0usize;

    // 1. Age
    let to_delete: Vec<PathBuf> = entries
        .iter()
        .filter(|e| now.saturating_sub(e.mtime) > max_age_secs)
        .map(|e| e.path.clone())
        .collect();
    for p in &to_delete {
        let _ = fs::remove_file(p);
    }
    entries.retain(|e| now.saturating_sub(e.mtime) <= max_age_secs);
    removed += to_delete.len();

    // 2. Count
    if entries.len() > max_files {
        entries.sort_by_key(|e| e.mtime);
        let to_drop = entries.len() - max_files;
        for e in entries.drain(..to_drop) {
            let _ = fs::remove_file(&e.path);
        }
        removed += to_drop;
    }

    // 3. Bytes (with hysteresis: aim for half the cap)
    let cap_bytes = max_bytes_mb.saturating_mul(1_048_576);
    let target_bytes = cap_bytes / 2;
    let total: u64 = entries.iter().map(|e| e.size).sum();
    if total > cap_bytes {
        entries.sort_by_key(|e| e.mtime);
        let mut running = total;
        while running > target_bytes && !entries.is_empty() {
            let e = entries.remove(0);
            running = running.saturating_sub(e.size);
            let _ = fs::remove_file(&e.path);
            removed += 1;
        }
    }

    Ok(removed)
}

fn read_entries(dir: &Path) -> io::Result<Vec<Entry>> {
    let mut out = Vec::new();
    for ent in fs::read_dir(dir)? {
        let ent = ent?;
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        let meta = ent.metadata()?;
        let mtime = meta
            .modified()
            .ok()
            .and_then(|m| m.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        out.push(Entry {
            path,
            size: meta.len(),
            mtime,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::env;
    use std::io::Write;

    fn touch_with_age(dir: &Path, name: &str, age_secs: u64, bytes: usize) {
        let p = dir.join(name);
        let mut f = fs::File::create(&p).unwrap();
        let chunk = vec![b'x'; 1024.min(bytes)];
        let mut written = 0usize;
        while written < bytes {
            let n = chunk.len().min(bytes - written);
            f.write_all(&chunk[..n]).unwrap();
            written += n;
        }
        f.sync_all().unwrap();
        drop(f);
        let mtime = SystemTime::now() - std::time::Duration::from_secs(age_secs);
        let times = fs::FileTimes::new().set_modified(mtime);
        let _ = fs::File::options()
            .write(true)
            .open(&p)
            .map(|f| f.set_times(times));
    }

    fn fresh_dir() -> std::path::PathBuf {
        let mut d = env::temp_dir();
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        d.push(format!("latte-debug-purge-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn available_bytes(dir: &Path) -> u64 {
        use std::os::unix::fs::MetadataExt as _;
        let stat = fs::metadata(dir).unwrap();
        stat.blocks() * stat.blksize()
    }

    #[test]
    fn removes_files_older_than_max_age() {
        let dir = fresh_dir();
        touch_with_age(&dir, "latte-debug.old.log", 10 * 86_400, 1024);
        touch_with_age(&dir, "latte-debug.fresh.log", 1 * 86_400, 1024);

        let removed = purge_old_logs(&dir, 7 * 86_400, 500, 50).unwrap();

        assert_eq!(removed, 1, "exactly one file should be removed");
        assert!(!dir.join("latte-debug.old.log").exists());
        assert!(dir.join("latte-debug.fresh.log").exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_total_dir_size() {
        let dir = fresh_dir();
        let avail = available_bytes(&dir);
        if avail < 1_200_000_000 {
            eprintln!("skipping caps_total_dir_size: only {avail} bytes free");
            return;
        }
        // 10 files x 100MB = 1GB; cap 500MB → drop at least 5.
        for i in 0..10 {
            touch_with_age(&dir, &format!("f{i}.log"), 86_400, 100 * 1024 * 1024);
        }
        let removed = purge_old_logs(&dir, 7 * 86_400, 500, 50).unwrap();
        assert!(
            removed >= 5,
            "should remove at least 5 files to drop under 500MB cap, removed={removed}"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn caps_max_file_count() {
        let dir = fresh_dir();
        for i in 0..60 {
            touch_with_age(&dir, &format!("f{i:02}.log"), 86_400, 1024);
        }
        let removed = purge_old_logs(&dir, 30 * 86_400, 10_000, 50).unwrap();
        assert!(
            removed >= 10,
            "expected to drop down to 50 files, removed={removed}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
