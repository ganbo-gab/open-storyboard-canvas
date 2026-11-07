//! Windows attachment IO uses pinned, non-reparse directory handles. The complete drive-to-vault
//! ancestor chain stays open without write/delete sharing, and commits rename the owned source
//! handle relative to a pinned destination handle. There is deliberately no pathname fallback.
//!
//! Only drive-rooted NTFS/ReFS volumes are supported. Other namespaces/filesystems fail closed;
//! directory reparse points (including junctions and cloud placeholders) are never traversed.
//! User-selected components must match their handle-reported normalized long names; short-name
//! aliases are rejected. The .trash traversal is an explicit internal hop, never user input.

use super::{KResult, KnowledgeError, MAX_ATTACHMENT_BYTES};
use std::ffi::{c_void, OsString};
use std::fs::File;
use std::io::{self, Read, Write};
use std::mem::{offset_of, size_of};
use std::os::windows::ffi::{OsStrExt, OsStringExt};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::path::{Component, Path, PathBuf, Prefix};
use windows_sys::Win32::Foundation::{
    ERROR_CALL_NOT_IMPLEMENTED, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER,
    ERROR_NOT_SUPPORTED, ERROR_SHARING_VIOLATION, GENERIC_READ, GENERIC_WRITE, HANDLE,
    INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Storage::FileSystem::{
    CreateDirectoryW, CreateFileW, FileAttributeTagInfo, FileDispositionInfo,
    GetFileInformationByHandleEx, GetFileType, GetFinalPathNameByHandleW,
    GetVolumeInformationByHandleW, SetFileInformationByHandle, CREATE_NEW, DELETE,
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO,
    FILE_DISPOSITION_INFO, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
    FILE_LIST_DIRECTORY, FILE_READ_ATTRIBUTES, FILE_RENAME_INFO, FILE_SHARE_DELETE,
    FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK, OPEN_EXISTING, VOLUME_NAME_GUID,
};

// SetFileInformationByHandle's rename wrapper can convert its FileName through DOS
// pathname resolution before calling the filesystem. That conflicts with a non-null
// RootDirectory and a basename (and returns ERROR_INVALID_PARAMETER on Windows).
// Use the native user-mode operation so the pinned destination handle remains the
// sole namespace authority. FILE_RENAME_INFO has FILE_RENAME_INFORMATION's ABI for
// the legacy ReplaceIfExists class on both 32-bit and 64-bit Windows.
#[repr(C)]
struct RenameIoStatus {
    // IO_STATUS_BLOCK starts with a union of NTSTATUS and a pointer. Reserve the
    // full pointer-sized slot; synchronous handles do not require reading it back.
    status_or_pointer: *mut c_void,
    information: usize,
}

#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtSetInformationFile(
        file: HANDLE,
        io_status: *mut RenameIoStatus,
        information: *const c_void,
        length: u32,
        information_class: i32,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}

const FILE_RENAME_INFORMATION: i32 = 10;

fn unsafe_path() -> KnowledgeError {
    KnowledgeError::new("UNSAFE_PATH", "Unsafe attachment path or reparse point")
}

fn unsupported() -> KnowledgeError {
    KnowledgeError::new("IO_ERROR", "Unsupported Windows filesystem or namespace: vault IO requires a drive-rooted NTFS/ReFS volume with no-follow handles and handle-relative rename support")
}

fn win_error(error: io::Error) -> KnowledgeError {
    match error.raw_os_error().map(|code| code as u32) {
        Some(
            ERROR_INVALID_FUNCTION
            | ERROR_NOT_SUPPORTED
            | ERROR_CALL_NOT_IMPLEMENTED
            | ERROR_INVALID_PARAMETER,
        ) => unsupported(),
        // Refuse an ancestor/source already held for mutation instead of retrying via a path.
        Some(ERROR_SHARING_VIOLATION) => unsafe_path(),
        _ => error.into(),
    }
}

fn last_error() -> KnowledgeError {
    win_error(io::Error::last_os_error())
}

fn validate_relative(relative: &str) -> KResult<()> {
    let encoded = relative
        .as_bytes()
        .windows(3)
        .any(|part| part[0] == b'%' && part[1].is_ascii_hexdigit() && part[2].is_ascii_hexdigit());
    if relative.is_empty()
        || encoded
        || relative
            .chars()
            .any(|value| value.is_control() || "\\:<>\"|?*".contains(value))
    {
        return Err(unsafe_path());
    }
    for part in relative.split('/') {
        let stem = part.split('.').next().unwrap_or("").trim_end_matches(' ');
        let numbered_device = stem.get(..3).is_some_and(|prefix| {
            prefix.eq_ignore_ascii_case("COM") || prefix.eq_ignore_ascii_case("LPT")
        }) && stem.get(3..).is_some_and(|suffix| {
            matches!(
                suffix,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
        if part.is_empty()
            || part == "."
            || part == ".."
            || part.ends_with(['.', ' '])
            || part.encode_utf16().take(256).count() > 255
            || part.eq_ignore_ascii_case(".obsidian")
            || part.eq_ignore_ascii_case(".trash")
            || part
                .get(..".knowledge-".len())
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case(".knowledge-"))
            || ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$", "CLOCK$"]
                .iter()
                .any(|name| stem.eq_ignore_ascii_case(name))
            || numbered_device
        {
            return Err(unsafe_path());
        }
    }
    Ok(())
}

fn validate_attachment(relative: &str) -> KResult<()> {
    validate_relative(relative)?;
    if !relative.starts_with("attachments/")
        || Path::new(relative)
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Attachments must be non-markdown files under attachments/",
        ));
    }
    Ok(())
}

fn wide_path(path: &Path) -> KResult<Vec<u16>> {
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    if wide.contains(&0) || wide.len() >= 32767 {
        return Err(unsafe_path());
    }
    wide.push(0);
    Ok(wide)
}

fn open_handle(path: &Path, access: u32, sharing: u32, disposition: u32) -> KResult<File> {
    let wide = wide_path(path)?;
    // SAFETY: the path is NUL-terminated; null security attributes make the new handle
    // non-inheritable. All pathname ancestors have already been pinned by the caller.
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            access,
            sharing,
            std::ptr::null(),
            disposition,
            FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        return Err(last_error());
    }
    // SAFETY: CreateFileW returned one new owned handle, transferred exactly once to File.
    Ok(unsafe { File::from_raw_handle(handle) })
}

fn attributes(file: &File) -> KResult<u32> {
    let mut information = FILE_ATTRIBUTE_TAG_INFO::default();
    // SAFETY: information is writable and has the exact layout and size required by this class.
    if unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileAttributeTagInfo,
            (&mut information as *mut FILE_ATTRIBUTE_TAG_INFO).cast(),
            size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    if information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        return Err(unsafe_path());
    }
    // SAFETY: file owns a live handle. Device/pipe handles are never accepted as vault entries.
    if unsafe { GetFileType(file.as_raw_handle()) } != FILE_TYPE_DISK {
        return Err(unsupported());
    }
    Ok(information.FileAttributes)
}

fn open_directory(path: &Path) -> KResult<File> {
    // Metadata-only access does not participate in share-access accounting. Request
    // directory read-data access so denying WRITE/DELETE sharing actually pins it.
    let file = open_handle(
        path,
        FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ,
        OPEN_EXISTING,
    )?;
    if attributes(&file)? & FILE_ATTRIBUTE_DIRECTORY == 0 {
        return Err(unsafe_path());
    }
    Ok(file)
}

fn validate_opened_name(file: &File, expected: &str) -> KResult<()> {
    // FILE_NAME_NORMALIZED (zero) resolves a short-name open to its long name.
    // Inspect the handle, never a second pathname lookup that could name another object.
    let mut local = [0u16; 1024];
    // SAFETY: the live handle is owned by the caller; local is writable for its full capacity.
    let mut length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            local.as_mut_ptr(),
            local.len() as u32,
            VOLUME_NAME_GUID,
        )
    };
    if length == 0 {
        return Err(last_error());
    }
    let mut extended;
    let buffer = if length as usize >= local.len() {
        // On insufficient capacity Windows returns the required size INCLUDING the NUL.
        // Avoid an allocation on ordinary paths while still supporting long vault paths.
        if length > 32768 {
            return Err(unsafe_path());
        }
        let capacity = length;
        extended = vec![0u16; capacity as usize];
        // SAFETY: extended has the requested writable capacity; the handle is still live.
        length = unsafe {
            GetFinalPathNameByHandleW(
                file.as_raw_handle(),
                extended.as_mut_ptr(),
                capacity,
                VOLUME_NAME_GUID,
            )
        };
        if length == 0 {
            return Err(last_error());
        }
        if length >= capacity {
            return Err(unsafe_path());
        }
        extended.as_slice()
    } else {
        local.as_slice()
    };
    let actual = buffer[..length as usize]
        .rsplit(|unit| *unit == u16::from(b'\\'))
        .next()
        .ok_or_else(unsafe_path)?;
    let ascii_fold = |unit: u16| {
        if (u16::from(b'A')..=u16::from(b'Z')).contains(&unit) {
            unit + 32
        } else {
            unit
        }
    };
    if !actual
        .iter()
        .copied()
        .map(ascii_fold)
        .eq(expected.encode_utf16().map(ascii_fold))
    {
        // Reject aliases altogether, not just aliases whose supplied spelling resembles
        // .obsidian/.trash/.knowledge-. Ordinary ASCII case differences remain accepted.
        return Err(unsafe_path());
    }
    Ok(())
}

struct Root {
    path: PathBuf,
    // Keep EVERY ancestor open: holding only the final directory does not protect
    // subsequent pathname opens against a rename/junction swap above that directory.
    chain: Vec<File>,
}

impl Root {
    fn open(root: &Path) -> KResult<Self> {
        let mut components = root.components();
        let prefix = match components.next() {
            Some(Component::Prefix(prefix))
                if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)) =>
            {
                prefix
            }
            _ => return Err(unsupported()),
        };
        if components.next() != Some(Component::RootDir) {
            return Err(unsafe_path());
        }
        let mut drive = PathBuf::from(prefix.as_os_str());
        drive.push(r"\");
        // The drive root itself has no pathname directory ancestor to traverse.
        let volume = open_directory(&drive)?;
        let mut filesystem = [0u16; 256];
        // SAFETY: output storage is valid; optional outputs are null. No mutation occurs.
        if unsafe {
            GetVolumeInformationByHandleW(
                volume.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                filesystem.as_mut_ptr(),
                filesystem.len() as u32,
            )
        } == 0
        {
            return Err(last_error());
        }
        let length = filesystem
            .iter()
            .position(|unit| *unit == 0)
            .ok_or_else(unsupported)?;
        if filesystem[..length] != [b'N' as u16, b'T' as u16, b'F' as u16, b'S' as u16]
            && filesystem[..length] != [b'R' as u16, b'e' as u16, b'F' as u16, b'S' as u16]
        {
            return Err(unsupported());
        }
        // Use the opened volume's GUID namespace for every subsequent open, not the
        // mutable per-session DOS drive mapping. UNC/remote roots cannot produce this form.
        let mut final_name = [0u16; 128];
        // SAFETY: the live volume handle and writable output buffer meet the API contract.
        let length = unsafe {
            GetFinalPathNameByHandleW(
                volume.as_raw_handle(),
                final_name.as_mut_ptr(),
                final_name.len() as u32,
                VOLUME_NAME_GUID,
            )
        };
        if length == 0 {
            return Err(last_error());
        }
        if length as usize >= final_name.len() {
            return Err(unsupported());
        }
        let mut path = PathBuf::from(OsString::from_wide(&final_name[..length as usize]));
        let volume_name = path.as_os_str().to_string_lossy();
        if !volume_name
            .strip_prefix(r"\\?\Volume{")
            .and_then(|rest| rest.split_once('}'))
            .is_some_and(|(identifier, suffix)| !identifier.is_empty() && suffix == r"\")
        {
            return Err(unsupported());
        }
        let mut chain = vec![volume];
        for component in components {
            match component {
                Component::Normal(name) => path.push(name),
                _ => return Err(unsafe_path()),
            }
            chain.push(open_directory(&path)?);
        }
        Ok(Self { path, chain })
    }

    fn parent<'a>(&'a self, relative: &'a str, create: bool) -> KResult<Parent<'a>> {
        self.parent_in(relative, create, false)
    }

    fn trash_parent<'a>(&'a self, relative: &'a str, create: bool) -> KResult<Parent<'a>> {
        self.parent_in(relative, create, true)
    }

    fn parent_in<'a>(
        &'a self,
        relative: &'a str,
        create: bool,
        trash: bool,
    ) -> KResult<Parent<'a>> {
        let (folders, name) = relative.rsplit_once('/').unwrap_or(("", relative));
        let mut path = self.path.clone();
        let mut chain = Vec::new();
        // Only this internal hop may enter .trash; relative always remains user input
        // without the prefix and is validated before any source/destination traversal.
        for part in trash
            .then_some(".trash")
            .into_iter()
            .chain(folders.split('/').filter(|part| !part.is_empty()))
        {
            path.push(part);
            let file = match open_directory(&path) {
                Ok(file) => file,
                Err(error) if create && error.code == "NOT_FOUND" => {
                    let wide = wide_path(&path)?;
                    // SAFETY: the complete parent chain is pinned; only this final directory
                    // may race. The subsequent no-follow open rejects any substituted reparse.
                    if unsafe { CreateDirectoryW(wide.as_ptr(), std::ptr::null()) } == 0 {
                        let error = last_error();
                        if error.code != "ALREADY_EXISTS" {
                            return Err(error);
                        }
                    }
                    open_directory(&path)?
                }
                Err(error) => return Err(error),
            };
            validate_opened_name(&file, part)?;
            chain.push(file);
        }
        Ok(Parent {
            root: self,
            path,
            chain,
            name,
        })
    }
}

/// Root-selection validation only. Every IO operation retains its own complete pin chain.
pub(crate) fn validate_root(root: &Path) -> KResult<()> {
    Root::open(root).map(|_| ())
}

struct Parent<'a> {
    root: &'a Root,
    path: PathBuf,
    chain: Vec<File>,
    name: &'a str,
}

impl Parent<'_> {
    fn handle(&self) -> HANDLE {
        // Root::open always records the drive root even when the vault is the volume root.
        self.chain
            .last()
            .unwrap_or_else(|| self.root.chain.last().expect("pinned volume"))
            .as_raw_handle()
    }

    fn open_source(&self, access: u32) -> KResult<(File, bool)> {
        let file = open_handle(
            &self.path.join(self.name),
            access | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,
            OPEN_EXISTING,
        )?;
        let is_directory = attributes(&file)? & FILE_ATTRIBUTE_DIRECTORY != 0;
        validate_opened_name(&file, self.name)?;
        Ok((file, is_directory))
    }
}

fn require_file(is_directory: bool) -> KResult<()> {
    if is_directory {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Expected an attachment file",
        ));
    }
    Ok(())
}

fn rename(file: &File, destination: &Parent<'_>, replace: bool) -> KResult<()> {
    let mut name = [0u16; 256];
    let mut length = 0;
    for unit in destination.name.encode_utf16() {
        if length == 255 {
            return Err(unsafe_path());
        }
        name[length] = unit;
        length += 1;
    }
    // A usize array gives FILE_RENAME_INFO its required native pointer alignment without
    // allocating. FileName is variable-length; write it at its real offset, not after the
    // padded header. The extra WCHAR is a terminator excluded from FileNameLength.
    const WORDS: usize = (size_of::<FILE_RENAME_INFO>() + 512).div_ceil(size_of::<usize>());
    let mut storage = [0usize; WORDS];
    let header = storage.as_mut_ptr().cast::<FILE_RENAME_INFO>();
    let bytes = offset_of!(FILE_RENAME_INFO, FileName) + (length + 1) * size_of::<u16>();
    // SAFETY: storage is aligned and large enough for the header and <=256 WCHARs.
    // destination owns the directory handle through the complete synchronous API call.
    unsafe {
        (*header).Anonymous.ReplaceIfExists = replace;
        (*header).RootDirectory = destination.handle();
        (*header).FileNameLength = (length * size_of::<u16>()) as u32;
        std::ptr::copy_nonoverlapping(
            name.as_ptr(),
            storage
                .as_mut_ptr()
                .cast::<u8>()
                .add(offset_of!(FILE_RENAME_INFO, FileName))
                .cast::<u16>(),
            length + 1,
        );
        let mut io_status = RenameIoStatus {
            status_or_pointer: std::ptr::null_mut(),
            information: 0,
        };
        // Every handle comes from CreateFileW without FILE_FLAG_OVERLAPPED, so this
        // call completes synchronously while all pins, buffer and IO status live.
        let status = NtSetInformationFile(
            file.as_raw_handle(),
            &mut io_status,
            header.cast(),
            bytes.max(size_of::<FILE_RENAME_INFO>()) as u32,
            FILE_RENAME_INFORMATION,
        );
        if status < 0 {
            return Err(win_error(io::Error::from_raw_os_error(
                RtlNtStatusToDosError(status) as i32,
            )));
        }
    }
    Ok(())
}

fn set_delete(file: &File, delete: bool) -> KResult<()> {
    let information = FILE_DISPOSITION_INFO { DeleteFile: delete };
    // SAFETY: FileDispositionInfo takes this exact, initialized structure. The handle
    // was opened with DELETE access; this operates on the owned stage, never a pathname.
    if unsafe {
        SetFileInformationByHandle(
            file.as_raw_handle(),
            FileDispositionInfo,
            (&information as *const FILE_DISPOSITION_INFO).cast(),
            size_of::<FILE_DISPOSITION_INFO>() as u32,
        )
    } == 0
    {
        return Err(last_error());
    }
    Ok(())
}

struct Stage {
    file: File,
    committed: bool,
}

impl Stage {
    fn create(parent: &Parent<'_>) -> KResult<Self> {
        let path = parent
            .path
            .join(format!(".knowledge-{}", uuid::Uuid::new_v4()));
        let stage = Self {
            file: open_handle(
                &path,
                GENERIC_WRITE | DELETE | FILE_READ_ATTRIBUTES,
                0,
                CREATE_NEW,
            )?,
            committed: false,
        };
        // Arm OS cleanup before writing, including a process exit during the write.
        // Unlike FILE_FLAG_DELETE_ON_CLOSE, this disposition can be cleared for commit.
        set_delete(&stage.file, true)?;
        Ok(stage)
    }
}

impl Drop for Stage {
    fn drop(&mut self) {
        if !self.committed {
            // Explicit error paths also report cleanup failure; this covers unwinding.
            let _ = set_delete(&self.file, true);
        }
    }
}

pub(super) fn read(root: &Path, relative: &str) -> KResult<Vec<u8>> {
    validate_attachment(relative)?;
    let root = Root::open(root)?;
    let parent = root.parent(relative, false)?;
    let (file, is_directory) = parent.open_source(GENERIC_READ)?;
    require_file(is_directory)?;
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
    validate_attachment(relative)?;
    if bytes.len() as u64 > MAX_ATTACHMENT_BYTES {
        return Err(KnowledgeError::new(
            "INVALID_ATTACHMENT",
            "Attachment exceeds 512 MiB",
        ));
    }
    let root = Root::open(root)?;
    let parent = root.parent(relative, true)?;
    // Reject an existing reparse/directory without following it. The check is NOT used
    // as the no-clobber guarantee: rename(false) below decides that atomically. A later
    // leaf swap cannot redirect the rename because its destination is one basename.
    match open_handle(
        &parent.path.join(parent.name),
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        OPEN_EXISTING,
    ) {
        Ok(file) => {
            require_file(attributes(&file)? & FILE_ATTRIBUTE_DIRECTORY != 0)?;
            validate_opened_name(&file, parent.name)?;
            if create_only {
                return Err(KnowledgeError::new(
                    "ALREADY_EXISTS",
                    "Attachment already exists",
                ));
            }
        }
        Err(error) if error.code == "NOT_FOUND" => {}
        Err(error) => return Err(error),
    }
    let mut stage = Stage::create(&parent)?;
    let result: KResult<()> = (|| {
        stage.file.write_all(bytes)?;
        stage.file.sync_all()?;
        set_delete(&stage.file, false)?;
        rename(&stage.file, &parent, !create_only)?;
        stage.committed = true;
        // Nothing fallible may run after the atomic commit.
        Ok(())
    })();
    if let Err(error) = result {
        if let Err(cleanup) = set_delete(&stage.file, true) {
            return Err(KnowledgeError::new(
                "IO_ERROR",
                format!(
                    "{}; staging cleanup failed: {}",
                    error.message, cleanup.message
                ),
            ));
        }
        return Err(error);
    }
    Ok(())
}

pub(super) fn trash(root: &Path, relative: &str) -> KResult<String> {
    validate_attachment(relative)?;
    let root = Root::open(root)?;
    let source = root.parent(relative, false)?;
    let (file, is_directory) = source.open_source(DELETE)?;
    require_file(is_directory)?;
    let original = Path::new(relative);
    let stem = original.file_stem().unwrap_or_default().to_string_lossy();
    let extension = original
        .extension()
        .map(|value| format!(".{}", value.to_string_lossy()))
        .unwrap_or_default();
    let (folder, _) = relative.rsplit_once('/').ok_or_else(unsafe_path)?;
    let mut candidate = relative.to_owned();
    let mut sequence = 2u64;
    loop {
        let destination = root.trash_parent(&candidate, true)?;
        match rename(&file, &destination, false) {
            Ok(()) => return Ok(candidate),
            Err(error) if error.code == "ALREADY_EXISTS" => {
                candidate = format!("{folder}/{stem} {sequence}{extension}");
                sequence = sequence.checked_add(1).ok_or_else(|| {
                    KnowledgeError::new("IO_ERROR", "Trash filename sequence exhausted")
                })?;
            }
            Err(error) => return Err(error),
        }
    }
}

pub(super) fn restore(root: &Path, trash_relative: &str, destination: &str) -> KResult<()> {
    validate_relative(trash_relative)?;
    validate_relative(destination)?;
    let root = Root::open(root)?;
    let source = root.trash_parent(trash_relative, false)?;
    let (file, is_directory) = source.open_source(DELETE)?;
    super::validate_restore_target(trash_relative, destination, is_directory)?;
    let destination = root.parent(destination, true)?;
    #[cfg(test)]
    super::tests::before_restore_move();
    // The exact source object is moved once. Collision/unsupported/error paths do not
    // unlink it, and no fallible operation runs after a successful atomic move.
    rename(&file, &destination, false)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::{Arc, Barrier};

    fn setup() -> (tempfile::TempDir, PathBuf) {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("vault");
        fs::create_dir(&root).unwrap();
        (directory, root)
    }

    fn junction(link: &Path, target: &Path) {
        // PathBuf::join accepts `/`, but cmd's mklink parses it as a switch even
        // inside an absolute path ("Invalid switch - linked"). Use native spelling.
        let link = link.as_os_str().to_string_lossy().replace('/', "\\");
        let target = target.as_os_str().to_string_lossy().replace('/', "\\");
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&link)
            .arg(&target)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "junction fixture failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn windows_handle_relative_rename_uses_pinned_parent_and_basename() {
        let (_directory, root) = setup();
        fs::create_dir_all(root.join("attachments/source")).unwrap();
        fs::create_dir_all(root.join("attachments/destination")).unwrap();
        fs::write(root.join("attachments/source/input.bin"), b"preserved").unwrap();
        let pinned = Root::open(&root).unwrap();
        let source = pinned
            .parent("attachments/source/input.bin", false)
            .unwrap();
        let (file, is_directory) = source.open_source(DELETE).unwrap();
        assert!(!is_directory);
        // Include a space and surrogate pair to exercise byte length vs UTF-16
        // component length. The Win32 wrapper must not turn this into a CWD path.
        let relative = "attachments/destination/output \u{1f4ce}.bin";
        let destination = pinned.parent(relative, false).unwrap();
        rename(&file, &destination, false).unwrap();
        drop(file);
        assert!(!root.join("attachments/source/input.bin").exists());
        assert_eq!(fs::read(root.join(relative)).unwrap(), b"preserved");
        no_staging(&root.join("attachments/destination"));
    }

    #[test]
    fn windows_junction_fixture_handles_mixed_separators_spaces_and_unicode() {
        let (_directory, root) = setup();
        fs::create_dir_all(root.join("attachments/folder with spaces")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("keep.bin"), b"outside").unwrap();
        let link = root.join("attachments/folder with spaces/linked \u{1f4ce}");
        junction(&link, outside.path());
        let metadata = fs::symlink_metadata(&link).unwrap();
        use std::os::windows::fs::MetadataExt;
        assert_ne!(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT, 0);
        assert_eq!(
            read(
                &root,
                "attachments/folder with spaces/linked \u{1f4ce}/keep.bin"
            )
            .unwrap_err()
            .code,
            "UNSAFE_PATH"
        );
        assert_eq!(
            fs::read(outside.path().join("keep.bin")).unwrap(),
            b"outside"
        );
        fs::remove_dir(link).unwrap();
    }

    fn no_staging(directory: &Path) {
        assert!(fs::read_dir(directory).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".knowledge-")
        }));
    }

    #[test]
    fn windows_binary_roundtrip_empty_replace_and_oversized_read() {
        let (_directory, root) = setup();
        let name = "attachments/nested/binary.bin";
        write(&root, name, &[0, 255, 0, 128], true).unwrap();
        assert_eq!(read(&root, name).unwrap(), [0, 255, 0, 128]);
        write(&root, name, &[], false).unwrap();
        assert!(read(&root, name).unwrap().is_empty());
        let oversized = fs::File::create(root.join("attachments/large.bin")).unwrap();
        oversized.set_len(MAX_ATTACHMENT_BYTES + 1).unwrap();
        drop(oversized);
        assert_eq!(
            read(&root, "attachments/large.bin").unwrap_err().code,
            "INVALID_ATTACHMENT"
        );
        no_staging(&root.join("attachments/nested"));
    }

    #[test]
    fn windows_boundary_rejects_scope_devices_streams_and_reserved_components() {
        let (_directory, root) = setup();
        for name in [
            "Keep.md",
            "attachments",
            "attachments/Keep.MD",
            "attachments/../escape.bin",
            "attachments//file.bin",
            "attachments/./file.bin",
            "attachments/NUL.bin",
            "attachments/COM1.bin",
            "attachments/LPT¹.bin",
            "attachments/file.bin:stream",
            "attachments/.trash/file.bin",
            "attachments/.obsidian/file.bin",
            "attachments/.knowledge-hidden/file.bin",
            "attachments/trailing. /file.bin",
            "attachments/encoded%2fescape.bin",
            "attachments\\file.bin",
            "/attachments/file.bin",
        ] {
            assert!(read(&root, name).is_err(), "{name}");
            assert!(write(&root, name, &[1], true).is_err(), "{name}");
            assert!(trash(&root, name).is_err(), "{name}");
        }
        for receipt in [
            ".trash/attachments/file.bin",
            "../attachments/file.bin",
            "/attachments/file.bin",
        ] {
            assert!(
                restore(&root, receipt, "attachments/file.bin").is_err(),
                "{receipt}"
            );
        }
        assert!(!root.join("attachments").exists());
        write(&root, "attachments/100% reference.bin", &[7], true).unwrap();
        assert_eq!(read(&root, "attachments/100% reference.bin").unwrap(), [7]);
    }

    #[test]
    fn windows_unsupported_namespaces_fail_before_filesystem_access() {
        for root in [r"\\unreachable.invalid\share\vault", r"\\.\C:\vault"] {
            let root = Path::new(root);
            let error = write(root, "attachments/new.bin", &[1], true).unwrap_err();
            assert_eq!(error.code, "IO_ERROR");
            assert!(error
                .message
                .contains("Unsupported Windows filesystem or namespace"));
            assert!(read(root, "attachments/new.bin").is_err());
            assert!(trash(root, "attachments/new.bin").is_err());
            assert!(restore(root, "attachments/new.bin", "attachments/restored.bin").is_err());
        }
    }

    #[test]
    fn windows_concurrent_creates_are_atomic_and_clean_staging() {
        let (_directory, root) = setup();
        let start = Arc::new(Barrier::new(8));
        let workers: Vec<_> = (0..8u8)
            .map(|value| {
                let root = root.clone();
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    write(&root, "attachments/nested/shared.bin", &[value], true).map(|()| value)
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        let winners: Vec<_> = results
            .iter()
            .filter_map(|result| result.as_ref().ok().copied())
            .collect();
        assert_eq!(winners.len(), 1);
        assert!(results
            .iter()
            .filter_map(|result| result.as_ref().err())
            .all(|error| error.code == "ALREADY_EXISTS"));
        assert_eq!(
            read(&root, "attachments/nested/shared.bin").unwrap(),
            winners
        );
        no_staging(&root.join("attachments/nested"));
    }

    #[test]
    fn windows_duplicate_trash_and_restore_preserve_every_source_on_conflict() {
        let (_directory, root) = setup();
        let name = "attachments/nested/sample.bin";
        write(&root, name, &[1], true).unwrap();
        assert_eq!(trash(&root, name).unwrap(), name);
        write(&root, name, &[2], true).unwrap();
        let second = trash(&root, name).unwrap();
        assert_eq!(second, "attachments/nested/sample 2.bin");
        assert_eq!(fs::read(root.join(".trash").join(name)).unwrap(), [1]);
        assert_eq!(fs::read(root.join(".trash").join(&second)).unwrap(), [2]);
        restore(&root, name, name).unwrap();
        assert_eq!(
            restore(&root, &second, name).unwrap_err().code,
            "ALREADY_EXISTS"
        );
        assert_eq!(read(&root, name).unwrap(), [1]);
        assert_eq!(fs::read(root.join(".trash").join(&second)).unwrap(), [2]);
        restore(&root, &second, "attachments/nested/restored.bin").unwrap();
        assert_eq!(read(&root, "attachments/nested/restored.bin").unwrap(), [2]);
    }

    #[test]
    fn windows_competing_restores_never_overwrite_or_consume_loser() {
        let (_directory, root) = setup();
        for (name, value) in [("attachments/one.bin", 1), ("attachments/two.bin", 2)] {
            write(&root, name, &[value], true).unwrap();
            trash(&root, name).unwrap();
        }
        let start = Arc::new(Barrier::new(2));
        let workers: Vec<_> = [("attachments/one.bin", 1), ("attachments/two.bin", 2)]
            .into_iter()
            .map(|(name, value)| {
                let root = root.clone();
                let start = start.clone();
                std::thread::spawn(move || {
                    start.wait();
                    (
                        name,
                        value,
                        restore(&root, name, "attachments/restored.bin"),
                    )
                })
            })
            .collect();
        let results: Vec<_> = workers
            .into_iter()
            .map(|worker| worker.join().unwrap())
            .collect();
        assert_eq!(
            results
                .iter()
                .filter(|(_, _, result)| result.is_ok())
                .count(),
            1
        );
        for (name, value, result) in results {
            if let Err(error) = result {
                assert_eq!(error.code, "ALREADY_EXISTS");
                assert_eq!(fs::read(root.join(".trash").join(name)).unwrap(), [value]);
            } else {
                assert_eq!(read(&root, "attachments/restored.bin").unwrap(), [value]);
                assert!(!root.join(".trash").join(name).exists());
            }
        }
    }

    #[test]
    fn windows_junction_ancestors_leaf_and_trash_are_not_followed() {
        let (_directory, root) = setup();
        let outside = tempfile::tempdir().unwrap();
        fs::write(outside.path().join("secret.bin"), [42]).unwrap();
        fs::create_dir(root.join("attachments")).unwrap();
        junction(&root.join("attachments/linked"), outside.path());
        for name in ["attachments/linked/secret.bin", "attachments/linked"] {
            assert_eq!(read(&root, name).unwrap_err().code, "UNSAFE_PATH");
            assert_eq!(
                write(&root, name, &[9], false).unwrap_err().code,
                "UNSAFE_PATH"
            );
            assert_eq!(trash(&root, name).unwrap_err().code, "UNSAFE_PATH");
        }
        assert_eq!(
            write(&root, "attachments/linked/new.bin", &[9], true)
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        write(&root, "attachments/keep.bin", &[3], true).unwrap();
        junction(&root.join(".trash"), outside.path());
        assert_eq!(
            trash(&root, "attachments/keep.bin").unwrap_err().code,
            "UNSAFE_PATH"
        );
        assert_eq!(read(&root, "attachments/keep.bin").unwrap(), [3]);
        assert_eq!(fs::read(outside.path().join("secret.bin")).unwrap(), [42]);
        assert!(!outside.path().join("new.bin").exists());
        fs::remove_dir(root.join("attachments/linked")).unwrap();
        fs::remove_dir(root.join(".trash")).unwrap();
    }

    #[test]
    fn windows_complete_ancestor_pins_deny_junction_swap_and_reparse_writers() {
        let (directory, root) = setup();
        write(&root, "attachments/nested/keep.bin", &[3], true).unwrap();
        let pinned_root = Root::open(&root).unwrap();
        let pinned_parent = pinned_root
            .parent("attachments/nested/keep.bin", false)
            .unwrap();
        for ancestor in [
            directory.path().to_path_buf(),
            root.clone(),
            root.join("attachments"),
            root.join("attachments/nested"),
        ] {
            let moved = ancestor.with_extension("swapped");
            assert!(
                fs::rename(&ancestor, &moved).is_err(),
                "unpinned ancestor: {}",
                ancestor.display()
            );
            assert!(open_handle(
                &ancestor,
                windows_sys::Win32::Foundation::GENERIC_WRITE,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                OPEN_EXISTING
            )
            .is_err());
        }
        assert_eq!(read(&root, "attachments/nested/keep.bin").unwrap(), [3]);
        drop(pinned_parent);
        drop(pinned_root);
        fs::rename(
            root.join("attachments/nested"),
            root.join("attachments/moved"),
        )
        .unwrap();
    }

    #[test]
    fn windows_directory_pins_deny_delete_and_write_access_until_released() {
        let (_directory, root) = setup();
        fs::create_dir_all(root.join("attachments/nested")).unwrap();
        let path = root.join("attachments/nested");
        let all_sharing = FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE;
        // Establish the fixture permits these accesses before testing the live pins.
        for access in [DELETE, GENERIC_WRITE] {
            drop(open_handle(&path, access, all_sharing, OPEN_EXISTING).unwrap());
        }
        {
            let pinned_root = Root::open(&root).unwrap();
            let _parent = pinned_root
                .parent("attachments/nested/item.bin", false)
                .unwrap();
            for access in [DELETE, GENERIC_WRITE] {
                assert!(open_handle(&path, access, all_sharing, OPEN_EXISTING).is_err());
            }
            assert!(fs::rename(&path, root.join("attachments/swapped")).is_err());
        }
        fs::rename(&path, root.join("attachments/swapped")).unwrap();
    }

    fn short_alias(path: &Path) -> String {
        use windows_sys::Win32::Storage::FileSystem::GetShortPathNameW;
        let wide = wide_path(path).unwrap();
        // SAFETY: the input is NUL-terminated and the zero-size call only queries capacity.
        let capacity = unsafe { GetShortPathNameW(wide.as_ptr(), std::ptr::null_mut(), 0) };
        assert!(
            capacity > 0,
            "short-name fixture query failed: {}",
            io::Error::last_os_error()
        );
        let mut buffer = vec![0u16; capacity as usize];
        // SAFETY: buffer has the exact capacity returned by the query.
        let length = unsafe { GetShortPathNameW(wide.as_ptr(), buffer.as_mut_ptr(), capacity) };
        assert!(length > 0 && length < capacity);
        let short = PathBuf::from(OsString::from_wide(&buffer[..length as usize]));
        let alias = short.file_name().unwrap().to_str().unwrap().to_owned();
        assert!(!alias.eq_ignore_ascii_case(path.file_name().unwrap().to_str().unwrap()),
            "This regression requires an NTFS test volume with 8.3 name creation enabled; no volume configuration is changed by the test");
        alias
    }

    #[test]
    fn windows_reserved_directory_short_alias_restore_preserves_trash_source() {
        let (_directory, root) = setup();
        fs::create_dir_all(root.join(".trash/notes")).unwrap();
        fs::create_dir(root.join(".obsidian")).unwrap();
        fs::write(root.join(".trash/notes/item.md"), b"keep").unwrap();
        for reserved in [".obsidian", ".trash"] {
            let alias = short_alias(&root.join(reserved));
            let destination = format!("{alias}/injected.md");
            assert_eq!(
                restore(&root, "notes/item.md", &destination)
                    .unwrap_err()
                    .code,
                "UNSAFE_PATH"
            );
            assert_eq!(
                fs::read(root.join(".trash/notes/item.md")).unwrap(),
                b"keep"
            );
            assert!(!root.join(reserved).join("injected.md").exists());
        }
        // The literal internal .trash hop remains allowed, unlike a caller-supplied alias.
        restore(&root, "notes/item.md", "notes/restored.md").unwrap();
        assert_eq!(fs::read(root.join("notes/restored.md")).unwrap(), b"keep");
    }

    #[test]
    fn windows_short_alias_ancestors_and_source_names_are_rejected() {
        let (_directory, root) = setup();
        write(&root, "attachments/Long directory/sample.bin", &[3], true).unwrap();
        let folder_alias = short_alias(&root.join("attachments/Long directory"));
        let aliased = format!("attachments/{folder_alias}/sample.bin");
        assert_eq!(read(&root, &aliased).unwrap_err().code, "UNSAFE_PATH");
        assert_eq!(
            write(&root, &aliased, &[9], false).unwrap_err().code,
            "UNSAFE_PATH"
        );
        assert_eq!(trash(&root, &aliased).unwrap_err().code, "UNSAFE_PATH");
        assert_eq!(
            read(&root, "attachments/Long directory/sample.bin").unwrap(),
            [3]
        );
        write(&root, "attachments/Long filename.bin", &[5], true).unwrap();
        let file_alias = short_alias(&root.join("attachments/Long filename.bin"));
        let aliased = format!("attachments/{file_alias}");
        assert_eq!(read(&root, &aliased).unwrap_err().code, "UNSAFE_PATH");
        assert_eq!(
            write(&root, &aliased, &[9], false).unwrap_err().code,
            "UNSAFE_PATH"
        );
        assert_eq!(trash(&root, &aliased).unwrap_err().code, "UNSAFE_PATH");
        assert_eq!(read(&root, "attachments/Long filename.bin").unwrap(), [5]);
    }

    #[test]
    fn windows_junction_above_vault_and_restore_target_preserve_sources() {
        let (directory, root) = setup();
        let alias = directory.path().join("alias");
        junction(&alias, directory.path());
        assert_eq!(
            write(&alias.join("vault"), "attachments/new.bin", &[7], true)
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert!(!root.join("attachments").exists());
        fs::remove_dir(alias).unwrap();
        write(&root, "attachments/keep.bin", &[5], true).unwrap();
        let receipt = trash(&root, "attachments/keep.bin").unwrap();
        let outside = tempfile::tempdir().unwrap();
        junction(&root.join("attachments/linked"), outside.path());
        assert_eq!(
            restore(&root, &receipt, "attachments/linked/keep.bin")
                .unwrap_err()
                .code,
            "UNSAFE_PATH"
        );
        assert_eq!(fs::read(root.join(".trash").join(receipt)).unwrap(), [5]);
        assert!(!outside.path().join("keep.bin").exists());
        fs::remove_dir(root.join("attachments/linked")).unwrap();
    }

    #[test]
    fn windows_failed_replacement_and_abandoned_stage_keep_original_and_clean_up() {
        let (_directory, root) = setup();
        let name = "attachments/keep.bin";
        write(&root, name, &[3], true).unwrap();
        let path = root.join(name);
        let original_permissions = fs::metadata(&path).unwrap().permissions();
        let mut readonly = original_permissions.clone();
        readonly.set_readonly(true);
        fs::set_permissions(&path, readonly).unwrap();
        let result = write(&root, name, &[9], false);
        fs::set_permissions(&path, original_permissions).unwrap();
        assert!(result.is_err());
        assert_eq!(read(&root, name).unwrap(), [3]);
        let pinned_root = Root::open(&root).unwrap();
        let parent = pinned_root.parent(name, false).unwrap();
        {
            let mut stage = Stage::create(&parent).unwrap();
            stage.file.write_all(&[8, 9]).unwrap();
        }
        no_staging(&root.join("attachments"));
    }

    #[test]
    fn windows_generic_note_and_folder_restore_remains_confined() {
        let (_directory, root) = setup();
        fs::create_dir_all(root.join(".trash/notes/folder")).unwrap();
        fs::write(root.join(".trash/notes/item.md"), b"note").unwrap();
        fs::write(root.join(".trash/notes/folder/nested.md"), b"nested").unwrap();
        assert!(restore(&root, "notes/item.md", "attachments/item.bin").is_err());
        assert_eq!(
            fs::read(root.join(".trash/notes/item.md")).unwrap(),
            b"note"
        );
        restore(&root, "notes/item.md", "notes/item.md").unwrap();
        restore(&root, "notes/folder", "notes/restored").unwrap();
        assert_eq!(fs::read(root.join("notes/item.md")).unwrap(), b"note");
        assert_eq!(
            fs::read(root.join("notes/restored/nested.md")).unwrap(),
            b"nested"
        );
    }
}
