use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Component, Path, PathBuf};

use flate2::read::GzDecoder;
use sha2::{Digest, Sha256};
use tar::Archive;

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

pub(crate) fn read_tar_gz_files(
    archive_bytes: &[u8],
    source_path: &str,
    allowed_files: &[String],
) -> Result<Vec<SourceFile>, DeployError> {
    if archive_bytes.len() as u64 > MAX_ARCHIVE_BYTES {
        return Err(DeployError::new("archive_size_limit"));
    }
    let allowed: BTreeSet<String> = allowed_files
        .iter()
        .map(|path| {
            validate_archive_entry(path, EntryKind::File, 0)
                .map(|safe| safe.to_string_lossy().into_owned())
        })
        .collect::<Result<_, _>>()?;
    let source_components: Vec<&str> = source_path
        .split('/')
        .filter(|component| !component.is_empty())
        .collect();
    let decoder = GzDecoder::new(archive_bytes);
    let mut archive = Archive::new(decoder);
    let entries = archive
        .entries()
        .map_err(|_| DeployError::new("invalid_archive"))?;
    let mut files = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|_| DeployError::new("invalid_archive"))?;
        let entry_type = entry.header().entry_type();
        let kind = if entry_type.is_file() {
            EntryKind::File
        } else if entry_type.is_dir() {
            EntryKind::Directory
        } else if entry_type.is_symlink() {
            EntryKind::Symlink
        } else if entry_type.is_hard_link() {
            EntryKind::Hardlink
        } else {
            EntryKind::Device
        };
        let raw_path = entry
            .path()
            .map_err(|_| DeployError::new("unsafe_archive"))?;
        let raw_path = raw_path
            .to_str()
            .ok_or_else(|| DeployError::new("unsafe_archive"))?;
        validate_archive_entry(raw_path, kind, entry.size())?;
        if kind == EntryKind::Directory {
            continue;
        }
        let components: Vec<&str> = raw_path.split('/').collect();
        if components.len() <= 1 + source_components.len()
            || components[1..1 + source_components.len()] != source_components
        {
            continue;
        }
        let relative = components[1 + source_components.len()..].join("/");
        if !allowed.contains(&relative) {
            continue;
        }
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .take(MAX_FILE_BYTES + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| DeployError::new("invalid_archive"))?;
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err(DeployError::new("archive_file_limit"));
        }
        files.push(SourceFile { path: relative, bytes });
    }
    files.sort_by(|left, right| left.path.cmp(&right.path));
    let found: BTreeSet<_> = files.iter().map(|file| file.path.clone()).collect();
    if found != allowed {
        return Err(DeployError::new("archive_file_missing"));
    }
    canonical_tree_digest(&files)?;
    Ok(files)
}
