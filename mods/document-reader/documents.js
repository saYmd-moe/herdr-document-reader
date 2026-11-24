import { appHome, exec } from "herdr";
import * as fs from "fs/promises";

const CACHE = "data/document-reader";
const CHUNK = 2 * 1024 * 1024;
const BASE64_REVERSE = new Int16Array(128).fill(-1);
for (let i = 0; i < 64; i++) BASE64_REVERSE["ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".charCodeAt(i)] = i;

export function basename(path) {
  return path.split(/[\\/]/).pop() ?? path;
}

export function dirname(path) {
  return path.replace(/[\\/][^\\/]*$/, "") || "/";
}

export function documentKind(path) {
  const ext = /\.([^./\\]+)$/.exec(path ?? "")?.[1]?.toLowerCase();
  if (ext === "pdf") return "pdf";
  if (["doc", "docx", "odt", "rtf"].includes(ext)) return "word";
  if (["xls", "xlsx", "ods"].includes(ext)) return "excel";
  if (["ppt", "pptx", "odp"].includes(ext)) return "powerpoint";
  return null;
}

export function supported(path) {
  return documentKind(path) !== null;
}

function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0") + text.length.toString(16);
}

function cacheRoot() {
  return `${appHome().split("\\").join("/")}/${CACHE}`;
}

function pngSize(bytes) {
  if (!bytes || bytes.length < 24 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  const at = (i) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  return { width: at(16), height: at(20) };
}

function temporary(dir) {
  return `${dir}/.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function run(command, args, on = null, timeout = 30000) {
  return exec(command, args, { on, timeout });
}

async function move(from, to, on = null) {
  const r = await run("mv", ["--", from, to], on);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not update the document cache");
}

async function remove(path, recursive = false, on = null) {
  const args = recursive ? ["-rf", "--", path] : ["-f", "--", path];
  await run("rm", args, on).catch(() => null);
}

export async function sourceSignature(file, on = null) {
  const r = await run("stat", ["-c", "%y:%s", "--", file], on).catch((error) => ({ code: -1, stderr: String(error) }));
  if (r.code !== 0) throw new Error(`Cannot read ${file}${on ? ` on ${on}` : ""}: ${r.stderr.trim() || "stat failed"}`);
  return r.stdout.trim();
}

async function convertLocalOffice(file, dir, kind) {
  const output = `${dir}/document.pdf`;
  if (await fs.exists(output)) return output;
  await fs.mkdir(cacheRoot(), { recursive: true });
  const work = temporary(cacheRoot());
  await fs.mkdir(work, { recursive: true });
  try {
    const profile = `${work}/profile`;
    const r = await run("env", [`TMPDIR=${work}`, "soffice",
      `-env:UserInstallation=file://${profile}`,
      "--headless", "--nologo", "--nodefault", "--nolockcheck", "--norestore",
      "--convert-to", "pdf", "--outdir", work, file,
    ], null, 180000);
    if (r.code !== 0) throw new Error(r.stderr.trim() || r.stdout.trim() || `LibreOffice could not convert this ${kind} document`);
    const made = (await fs.readdir(work)).find((name) => name.toLowerCase().endsWith(".pdf"));
    if (!made) throw new Error(r.stdout.trim() || r.stderr.trim() || "LibreOffice did not produce a PDF");
    await fs.mkdir(dir, { recursive: true });
    await move(`${work}/${made}`, output);
    return output;
  } finally {
    await remove(work, true);
  }
}

async function remoteExists(path, on) {
  const r = await run("test", ["-f", path], on);
  if (r.code === 0) return true;
  if (r.code === 1) return false;
  throw new Error(r.stderr.trim() || `Could not check ${path} on ${on}`);
}

async function remoteHome(on) {
  const r = await run("pwd", [], on).catch((error) => ({ code: -1, stderr: String(error) }));
  if (r.code !== 0 || !r.stdout.trim()) throw new Error(r.stderr.trim() || `Could not reach ${on}`);
  return r.stdout.trim();
}

async function pruneRemoteCache(on, home) {
  const root = `${home}/.cache/herdr-document-reader`;
  await run("sh", ["-c", 'if [ -d "$1" ]; then find "$1" -mindepth 1 -maxdepth 1 -type d -mtime +14 -exec rm -rf -- {} +; fi', "document-reader-prune", root], on).catch(() => null);
}

async function convertRemoteOffice(file, remoteDir, kind, on) {
  const output = `${remoteDir}/document.pdf`;
  if (await remoteExists(output, on)) return output;
  const work = temporary(remoteDir);
  const r = await run("mkdir", ["-p", work], on);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not create the remote document cache");
  try {
    const profile = `${work}/profile`;
    const converted = await run("env", [`TMPDIR=${work}`, "soffice",
      `-env:UserInstallation=file://${profile}`,
      "--headless", "--nologo", "--nodefault", "--nolockcheck", "--norestore",
      "--convert-to", "pdf", "--outdir", work, file,
    ], on, 180000);
    if (converted.code !== 0) throw new Error(converted.stderr.trim() || converted.stdout.trim() || `LibreOffice could not convert this ${kind} document on ${on}`);
    const made = `${work}/${basename(file).replace(/\.[^.]+$/, ".pdf")}`;
    if (!(await remoteExists(made, on))) throw new Error(converted.stdout.trim() || converted.stderr.trim() || "LibreOffice did not produce a PDF");
    const mk = await run("mkdir", ["-p", remoteDir], on);
    if (mk.code !== 0) throw new Error(mk.stderr.trim() || "Could not create the remote document cache");
    await move(made, output, on);
    return output;
  } finally {
    await remove(work, true, on);
  }
}

export async function openDocument(file, on = null) {
  const kind = documentKind(file);
  if (!kind) throw new Error("Choose a PDF, Word, Excel or PowerPoint document");
  const signature = await sourceSignature(file, on);
  const key = hash(`${on ?? "local"}\0${file}\0${signature}`);
  const dir = `${cacheRoot()}/${key}`;
  let pdf = file;
  let remoteDir = null;
  if (on) {
    const home = await remoteHome(on);
    await pruneRemoteCache(on, home);
    remoteDir = `${home}/.cache/herdr-document-reader/${key}`;
    if (kind !== "pdf") pdf = await convertRemoteOffice(file, remoteDir, kind, on);
  } else if (kind !== "pdf") pdf = await convertLocalOffice(file, dir, kind);
  const r = await run("pdfinfo", [pdf], on, 60000);
  if (r.code !== 0) {
    const detail = r.stderr.trim() || r.stdout.trim();
    if (/password|encrypted/i.test(detail)) throw new Error("Password-protected documents are not supported yet");
    throw new Error(detail || "pdfinfo could not read this document");
  }
  const count = Number(/^Pages:\s+(\d+)\s*$/m.exec(r.stdout)?.[1]);
  if (!Number.isInteger(count) || count < 1) throw new Error("This document has no readable pages");
  return { file, on, kind, signature, key, dir, pdf, remoteDir, count, cache: `${CACHE}/${key}` };
}

function base64Bytes(text, expected) {
  const out = new Uint8Array(expected);
  let acc = 0;
  let bits = 0;
  let index = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 61) break;
    const value = code < 128 ? BASE64_REVERSE[code] : -1;
    if (value < 0) continue;
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (acc >> bits) & 255;
    }
  }
  if (index !== expected) throw new Error(`Remote page transfer was truncated (${index}/${expected} bytes)`);
  return out;
}

async function download(remote, output, on) {
  const info = await run("stat", ["-c", "%s", "--", remote], on, 120000);
  if (info.code !== 0) throw new Error(info.stderr.trim() || "Could not measure a rendered remote page");
  const size = Number(info.stdout.trim());
  if (!Number.isInteger(size) || size < 1) throw new Error("The remote renderer produced an empty file");
  const bytes = new Uint8Array(size);
  for (let offset = 0; offset < size; offset += CHUNK) {
    const count = Math.min(CHUNK, size - offset);
    const r = await run("sh", ["-c", 'dd if="$1" iflag=skip_bytes,count_bytes skip="$2" count="$3" status=none | base64 -w0', "document-reader-download", remote, String(offset), String(count)], on, 120000);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not download a rendered remote page");
    const chunk = base64Bytes(r.stdout, count);
    if (chunk.length !== count) throw new Error(`Remote page transfer was truncated (${chunk.length}/${count} bytes)`);
    bytes.set(chunk, offset);
  }
  const temp = `${output}.download-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  try {
    await fs.writeFile(temp, bytes);
    await move(temp, output);
  } finally {
    await remove(temp);
  }
}

async function renderRemotePage(doc, n, quality, output) {
  const remoteOutput = `${doc.remoteDir}/page-${n}-${quality}.png`;
  if (!(await remoteExists(remoteOutput, doc.on))) {
    const mk = await run("mkdir", ["-p", doc.remoteDir], doc.on);
    if (mk.code !== 0) throw new Error(mk.stderr.trim() || "Could not create the remote page cache");
    const prefix = temporary(doc.remoteDir);
    const temp = `${prefix}.png`;
    try {
      const r = await run("pdftoppm", [
        "-f", String(n), "-l", String(n), "-singlefile", "-scale-to", String(quality),
        "-png", doc.pdf, prefix,
      ], doc.on, 120000);
      if (r.code !== 0) throw new Error(r.stderr.trim() || `Could not render page ${n} on ${doc.on}`);
      await move(temp, remoteOutput, doc.on);
    } finally {
      await remove(temp, false, doc.on);
    }
  }
  await download(remoteOutput, output, doc.on);
}

export async function renderPage(doc, page, quality = 1800) {
  const n = Math.max(1, Math.min(doc.count, page));
  await fs.mkdir(doc.dir, { recursive: true });
  const output = `${doc.dir}/page-${n}-${quality}.png`;
  if (!(await fs.exists(output))) {
    if (doc.on) await renderRemotePage(doc, n, quality, output);
    else {
      const prefix = temporary(doc.dir);
      const temp = `${prefix}.png`;
      try {
        const r = await run("pdftoppm", [
          "-f", String(n), "-l", String(n), "-singlefile", "-scale-to", String(quality),
          "-png", doc.pdf, prefix,
        ], null, 120000);
        if (r.code !== 0) throw new Error(r.stderr.trim() || `Could not render page ${n}`);
        await move(temp, output);
      } finally {
        await remove(temp);
      }
    }
  }
  const size = pngSize(await fs.readFile(output));
  if (!size) throw new Error(`Page ${n} was not rendered as a valid PNG`);
  return { n, quality, path: `${doc.cache}/page-${n}-${quality}.png`, ...size };
}

export async function textPages(doc) {
  const r = await run("pdftotext", ["-enc", "UTF-8", "-eol", "unix", doc.pdf, "-"], doc.on, 120000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not extract document text");
  return r.stdout.split("\f");
}

export async function pruneCache(active = new Set()) {
  const root = cacheRoot();
  const names = await fs.readdir(root).catch(() => []);
  const entries = [];
  for (const name of names) {
    if (active.has(name)) continue;
    const path = `${root}/${name}`;
    const r = await run("stat", ["-c", "%Y:%F", "--", path]).catch(() => null);
    if (r?.code !== 0 || !r.stdout.includes("directory")) continue;
    entries.push({ path, name, mtime: Number(r.stdout.split(":")[0]) * 1000 });
  }
  const cutoff = Date.now() - 14 * 86400000;
  const old = entries.filter((entry) => entry.name.startsWith(".tmp-") ? entry.mtime < Date.now() - 86400000 : entry.mtime < cutoff);
  const excess = entries.filter((entry) => !entry.name.startsWith(".tmp-")).sort((a, b) => b.mtime - a.mtime).slice(60);
  for (const entry of new Set([...old, ...excess])) await remove(entry.path, true);
}
