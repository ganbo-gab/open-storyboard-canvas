//! Descriptor-relative attachment IO and generic trash restoration. No-follow parent
//! descriptors pin filesystem operations across concurrent ancestor symlink swaps.
use super::{KResult, KnowledgeError, MAX_ATTACHMENT_BYTES};
use std::ffi::CString;
use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Component, Path};

fn cstring(value: &str) -> KResult<CString> {
    CString::new(value).map_err(|_| KnowledgeError::new("UNSAFE_PATH", "Invalid attachment path"))
}
fn io_error() -> KnowledgeError {
    let error = std::io::Error::last_os_error();
    match error.raw_os_error() {
        Some(libc::ELOOP) | Some(libc::ENOTDIR) => KnowledgeError::new(
            "UNSAFE_PATH",
            "Symlink or non-directory ancestor is forbidden",
        ),
        _ => error.into(),
    }
}
fn root_directory(root: &Path) -> KResult<File> {
    if !root.is_absolute() {
        return Err(KnowledgeError::new(
            "INVALID_VAULT",
            "Vault root must be absolute",
        ));
    }
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open("/")?;
    for component in root.components() {
        let part = match component {
            Component::RootDir => continue,
            Component::Normal(part) => part,
            _ => {
                return Err(KnowledgeError::new(
                    "UNSAFE_PATH",
                    "Expected a canonical vault root",
                ))
            }
        };
        let name = CString::new(part.as_bytes())
            .map_err(|_| KnowledgeError::new("UNSAFE_PATH", "Invalid vault root"))?;
        let fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0 {
            return Err(io_error());
        }
        // SAFETY: openat returned a new, owned descriptor on success.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}
/// Validate the authorized pathname without canonicalizing or following any ancestor.
/// IO operations independently reopen and retain their own descriptor-relative pins.
pub(super) fn validate_root(root: &Path) -> KResult<()> {
    root_directory(root).map(|_| ())
}
fn parent(root: &Path, relative: &str, create: bool) -> KResult<(File, CString)> {
    parent_from(root_directory(root)?, relative, create)
}
fn parent_from(mut directory: File, relative: &str, create: bool) -> KResult<(File, CString)> {
    let (folders, name) = relative.rsplit_once('/').unwrap_or(("", relative));
    for part in folders.split('/').filter(|part| !part.is_empty()) {
        let name = cstring(part)?;
        let mut fd = unsafe {
            libc::openat(
                directory.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };
        if fd < 0
            && create
            && std::io::Error::last_os_error().kind() == std::io::ErrorKind::NotFound
        {
            let result = unsafe { libc::mkdirat(directory.as_raw_fd(), name.as_ptr(), 0o700) };
            if result < 0
                && std::io::Error::last_os_error().kind() != std::io::ErrorKind::AlreadyExists
            {
                return Err(io_error());
            }
            directory.sync_all()?;
            fd = unsafe {
                libc::openat(
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
        }
        if fd < 0 {
            return Err(io_error());
        }
        // SAFETY: openat returned a new, owned descriptor on success.
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok((directory, cstring(name)?))
}
fn open_entry(directory: &File, name: &CString) -> KResult<File> {
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(io_error());
    }
    // SAFETY: openat returned a new, owned descriptor on success.
    Ok(unsafe { File::from_raw_fd(fd) })
}
fn open_file(directory: &File, name: &CString) -> KResult<File> {
    let file = open_entry(directory, name)?;
    if !file.metadata()?.is_file() {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Expected an attachment file",
        ));
    }
    Ok(file)
}
pub(super) fn read(root: &Path, relative: &str) -> KResult<Vec<u8>> {
    let (directory, name) = parent(root, relative, false)?;
    let file = open_file(&directory, &name)?;
    let size = file.metadata()?.len();
    if size > MAX_ATTACHMENT_BYTES {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Attachment exceeds 512 MiB",
        ));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    file.take(MAX_ATTACHMENT_BYTES + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Attachment exceeds 512 MiB",
        ));
    }
    Ok(bytes)
}
pub(super) fn write(root: &Path, relative: &str, bytes: &[u8], create_only: bool) -> KResult<()> {
    let (directory, name) = parent(root, relative, true)?;
    let temporary = cstring(&format!(".knowledge-{}", uuid::Uuid::new_v4()))?;
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            temporary.as_ptr(),
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            0o600,
        )
    };
    if fd < 0 {
        return Err(io_error());
    }
    let mut file = unsafe { File::from_raw_fd(fd) };
    let result = (|| {
        file.write_all(bytes)?;
        file.sync_all()?;
        let result = if create_only {
            unsafe {
                libc::linkat(
                    directory.as_raw_fd(),
                    temporary.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                    0,
                )
            }
        } else {
            unsafe {
                libc::renameat(
                    directory.as_raw_fd(),
                    temporary.as_ptr(),
                    directory.as_raw_fd(),
                    name.as_ptr(),
                )
            }
        };
        if result < 0 {
            return Err(io_error());
        }
        directory.sync_all()?;
        Ok(())
    })();
    // rename consumes the temporary name; link/no-clobber and failed writes leave it behind.
    unsafe {
        libc::unlinkat(directory.as_raw_fd(), temporary.as_ptr(), 0);
    }
    result
}

fn require_atomic_move() -> KResult<()> {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        Ok(())
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    {
        Err(KnowledgeError::new(
            "IO_ERROR",
            "Atomic no-replacement moves are unavailable on this platform",
        ))
    }
}
#[cfg(target_os = "macos")]
fn rename_noclobber(
    source: &File,
    name: &CString,
    destination: &File,
    target: &CString,
) -> KResult<()> {
    let result = unsafe {
        libc::renameatx_np(
            source.as_raw_fd(),
            name.as_ptr(),
            destination.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_EXCL,
        )
    };
    if result < 0 {
        return Err(io_error());
    }
    Ok(())
}
#[cfg(target_os = "linux")]
fn rename_noclobber(
    source: &File,
    name: &CString,
    destination: &File,
    target: &CString,
) -> KResult<()> {
    let result = unsafe {
        libc::renameat2(
            source.as_raw_fd(),
            name.as_ptr(),
            destination.as_raw_fd(),
            target.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if result < 0 {
        return Err(io_error());
    }
    Ok(())
}
#[cfg(not(any(target_os = "macos", target_os = "linux")))]
fn rename_noclobber(
    _source: &File,
    _name: &CString,
    _destination: &File,
    _target: &CString,
) -> KResult<()> {
    require_atomic_move()
}
pub(super) fn trash(root: &Path, relative: &str) -> KResult<String> {
    require_atomic_move()?;
    let (source, name) = parent(root, relative, false)?;
    let _file = open_file(&source, &name)?;
    let original = Path::new(relative);
    let stem = original.file_stem().unwrap_or_default().to_string_lossy();
    let extension = original
        .extension()
        .map(|extension| format!(".{}", extension.to_string_lossy()))
        .unwrap_or_default();
    let folder = original.parent().unwrap_or(Path::new(""));
    let mut candidate = relative.to_string();
    let mut sequence = 2;
    loop {
        let (destination, target) = parent(root, &format!(".trash/{candidate}"), true)?;
        match rename_noclobber(&source, &name, &destination, &target) {
            Ok(()) => {
                destination.sync_all()?;
                source.sync_all()?;
                return Ok(candidate);
            }
            Err(error) if error.code == "ALREADY_EXISTS" => {}
            Err(error) => return Err(error),
        }
        candidate = folder
            .join(format!("{stem} {sequence}{extension}"))
            .to_string_lossy()
            .into_owned();
        sequence += 1;
    }
}

pub(super) fn restore(root: &Path, trash_relative: &str, relative: &str) -> KResult<()> {
    require_atomic_move()?;
    let root = root_directory(root)?;
    let (source, name) = parent_from(
        root.try_clone()?,
        &format!(".trash/{trash_relative}"),
        false,
    )?;
    let entry = open_entry(&source, &name)?;
    let metadata = entry.metadata()?;
    if !metadata.is_file() && !metadata.is_dir() {
        return Err(KnowledgeError::new(
            "UNSAFE_PATH",
            "Expected a regular file or folder in trash",
        ));
    }
    super::validate_restore_target(trash_relative, relative, metadata.is_dir())?;
    let (destination, target) = parent_from(root, relative, true)?;
    // Flush all fallible preconditions before the atomic commit. In particular,
    // never return a post-rename sync error after consuming the recoverable trash name.
    entry.sync_all()?;
    source.sync_all()?;
    destination.sync_all()?;
    #[cfg(test)]
    super::tests::before_restore_move();
    rename_noclobber(&source, &name, &destination, &target)
}
