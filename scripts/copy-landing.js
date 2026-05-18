import fs from 'fs/promises';
import path from 'path';

const SRC = path.resolve('src/pages/landing');
const DEST = path.resolve('public/landing');

async function copyDir(src, dest) {
  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else if (entry.isFile()) {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

(async () => {
  try {
    await fs.stat(SRC);
  } catch (err) {
    console.error(`Source not found: ${SRC}`);
    process.exit(1);
  }
  try {
    await copyDir(SRC, DEST);
    console.log(`Copied ${SRC} -> ${DEST}`);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
