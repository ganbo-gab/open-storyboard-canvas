import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const textExtensions = new Set([
  '.bat', '.cjs', '.cmd', '.css', '.gitignore', '.gitattributes', '.html', '.js', '.jsx',
  '.json', '.jsonl', '.lock', '.md', '.mjs', '.ps1', '.rs', '.sh', '.toml', '.ts', '.tsx',
  '.txt', '.xml', '.yaml', '.yml',
]);
const textBasenames = new Set(['Cargo.lock', 'LICENSE']);

const trackedFiles = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
const invalidFiles = [];
let checkedTextFiles = 0;

for (const file of trackedFiles) {
  // Deleted tracked files remain in the index until the user stages the change.
  if (!existsSync(file)) continue;
  const basename = path.basename(file);
  const extension = basename.startsWith('.') ? basename : path.extname(basename).toLowerCase();
  if (!textBasenames.has(basename) && !textExtensions.has(extension)) continue;

  const bytes = readFileSync(file);
  checkedTextFiles++;
  if (bytes.includes(0x00)) {
    invalidFiles.push(`${file}: contains NUL/UTF-16 bytes`);
    continue;
  }
  if (bytes.includes(0x0d)) invalidFiles.push(`${file}: contains CR or CRLF line endings`);
}

if (invalidFiles.length) {
  console.error('Tracked text files must use UTF-8-compatible LF line endings:');
  for (const issue of invalidFiles) console.error(`- ${issue}`);
  process.exitCode = 1;
} else {
  console.log(`Checked ${checkedTextFiles} existing tracked text files: line endings are LF-only.`);
}
