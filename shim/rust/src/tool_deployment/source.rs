use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};

use super::DeployError;

pub(crate) const MAX_ARCHIVE_BYTES: u64 = 50 * 1024 * 1024;
pub(crate) const MAX_FILE_BYTES: u64 = 5 * 1024 * 1024;
pub(crate) const MAX_FILE_COUNT: usize = 2_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntryKind {
    File,
    Directory,
    Symlink,
    Hardlink,
    Device,
}

#[derive(Debug, Clone)]
pub(crate) struct SourceFile {
    pub path: String,
    pub bytes: Vec<u8>,
}

pub(crate) fn validate_archive_entry(
    path: &str,
    kind: EntryKind,
    size: u64,
) -> Result<PathBuf, DeployError> {
    if size > MAX_FILE_BYTES
        || path.is_empty()
        || path.contains('\0')
        || path.contains('\\')
        || path.contains("//")
        || matches!(kind, EntryKind::Symlink | EntryKind::Hardlink | EntryKind::Device)
    {
        return Err(DeployError::new("unsafe_archive"));
    }
    let candidate = Path::new(path);
    if candidate.is_absolute()
        || candidate.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(DeployError::new("unsafe_archive"));
    }
    Ok(candidate.to_path_buf())
}

fn update_length_framed(hash: &mut Sha256, value: &[u8]) {
    hash.update(value.len().to_string().as_bytes());
    hash.update(b":");
    hash.update(value);
    hash.update(b":");
}

pub(crate) fn canonical_tree_digest(files: &[SourceFile]) -> Result<String, DeployError> {
    if files.len() > MAX_FILE_COUNT {
        return Err(DeployError::new("archive_file_limit"));
    }
    let mut sorted = files.to_vec();
    sorted.sort_by(|left, right| left.path.cmp(&right.path));
    let mut seen = BTreeSet::new();
    let mut total = 0_u64;
    let mut hash = Sha256::new();
    for file in sorted {
        validate_archive_entry(&file.path, EntryKind::File, file.bytes.len() as u64)?;
        if !seen.insert(file.path.clone()) {
            return Err(DeployError::new("duplicate_archive_path"));
        }
        total = total.saturating_add(file.bytes.len() as u64);
        if total > MAX_ARCHIVE_BYTES {
            return Err(DeployError::new("archive_size_limit"));
        }
        update_length_framed(&mut hash, file.path.as_bytes());
        update_length_framed(&mut hash, &file.bytes);
    }
    Ok(format!("sha256:{:x}", hash.finalize()))
}
