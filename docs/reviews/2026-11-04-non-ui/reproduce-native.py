"""Run cross-language snapshot checks in a temporary native-source copy.

Run the channel-snapshot probe first when refreshing fixture files.
The two contract assertions currently fail on the reviewed production source.
"""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

audit = Path(__file__).resolve().parent
root = audit.parents[2]
temporary = Path(tempfile.mkdtemp(prefix="storyboard-audit-native-"))
native = temporary / "src-tauri"
shutil.copytree(root / "src-tauri", native, ignore=shutil.ignore_patterns("target", ".DS_Store"))
(temporary / "dist").symlink_to(root / "dist", target_is_directory=True)
source = (native / "src/commands/ai.rs").read_text()
needle = "mod tests {\n    use super::*;"
assert source.count(needle) == 1
probe = ""
for kind in ("transient", "chat"):
    fixture = json.dumps(str(audit / f"{kind}-snapshot.json"), ensure_ascii=False)
    removal = ('baseline.as_object_mut().unwrap().remove("credentialSource");'
               if kind == "transient" else 'baseline["input"].as_object_mut().unwrap().remove("chatPayload");')
    probe += f"""
    #[test]
    fn audit_{kind}_typescript_snapshot_contract() {{
        let actual: Value = serde_json::from_str(include_str!({fixture})).unwrap();
        let mut baseline = actual.clone();
        {removal}
        assert!(sanitize_poll_descriptor(Some(baseline)).is_ok(), "control snapshot must be valid");
        let result = sanitize_poll_descriptor(Some(actual));
        assert!(result.is_ok(), "Actual TypeScript {kind} snapshot rejected: {{:?}}", result);
    }}
"""
(native / "src/commands/ai.rs").write_text(source.replace(needle, needle + probe))
environment = dict(os.environ, CARGO_TARGET_DIR=str(root / "src-tauri/target"))
print(f"Testing isolated source copy: {native}", flush=True)
raise SystemExit(subprocess.call([
    "cargo", "test", "--locked", "--offline", "--manifest-path", str(native / "Cargo.toml"),
    "--lib", "typescript_snapshot_contract", "--", "--nocapture",
], cwd=root, env=environment))
