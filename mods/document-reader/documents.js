import { appHome, exec } from "herdr";
import * as fs from "fs/promises";

const OFFICE = new Set(["doc", "docx", "odt", "rtf", "xls", "xlsx", "ods", "ppt", "pptx", "odp"]);
const CACHE = "data/document-reader";

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
  return OFFICE.has(ext) ? "office" : null;
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

async function move(from, to) {
  const r = await exec("mv", ["--", from, to]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "Could not update the document cache");
}

async function remove(path, recursive = false) {
  const args = recursive ? ["-rf", "--", path] : ["-f", "--", path];
  await exec("rm", args).catch(() => null);
}

export async function sourceSignature(file) {
  const r = await exec("stat", ["-c", "%y:%s", "--", file]).catch((error) => ({ code: -1, stderr: String(error) }));
  if (r.code !== 0) throw new Error(`Cannot read ${file}: ${r.stderr.trim() || "stat failed"}`);
  return r.stdout.trim();
}

async function convertOffice(file, dir, kind) {
  const output = `${dir}/document.pdf`;
  if (await fs.exists(output)) return output;
  await fs.mkdir(cacheRoot(), { recursive: true });
  const work = temporary(cacheRoot());
  await fs.mkdir(work, { recursive: true });
  try {
    const profile = `${work}/profile`;
    const r = await exec("env", [`TMPDIR=${work}`, "soffice",
      `-env:UserInstallation=file://${profile}`,
      "--headless", "--nologo", "--nodefault", "--nolockcheck", "--norestore",
      "--convert-to", "pdf", "--outdir", work, file,
    ], { timeout: 180000 });
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

export async function openDocument(file) {
  const kind = documentKind(file);
  if (!kind) throw new Error("Choose a PDF, Word, Excel or PowerPoint document");
  const signature = await sourceSignature(file);
  const key = hash(`${file}\0${signature}`);
  const dir = `${cacheRoot()}/${key}`;
  const pdf = kind === "pdf" ? file : await convertOffice(file, dir, kind);
  const r = await exec("pdfinfo", [pdf], { timeout: 60000 });
  if (r.code !== 0) {
    const detail = r.stderr.trim() || r.stdout.trim();
    if (/password|encrypted/i.test(detail)) throw new Error("Password-protected documents are not supported yet");
    throw new Error(detail || "pdfinfo could not read this document");
  }
  const count = Number(/^Pages:\s+(\d+)\s*$/m.exec(r.stdout)?.[1]);
  if (!Number.isInteger(count) || count < 1) throw new Error("This document has no readable pages");
  return { file, kind, signature, key, dir, pdf, count, cache: `${CACHE}/${key}` };
}

export async function renderPage(doc, page, quality = 1800) {
  const n = Math.max(1, Math.min(doc.count, page));
  await fs.mkdir(doc.dir, { recursive: true });
  const output = `${doc.dir}/page-${n}-${quality}.png`;
  if (!(await fs.exists(output))) {
    const prefix = temporary(doc.dir);
    const temp = `${prefix}.png`;
    try {
      const r = await exec("pdftoppm", [
        "-f", String(n), "-l", String(n), "-singlefile", "-scale-to", String(quality),
        "-png", doc.pdf, prefix,
      ], { timeout: 120000 });
      if (r.code !== 0) throw new Error(r.stderr.trim() || `Could not render page ${n}`);
      await move(temp, output);
    } finally {
      await remove(temp);
    }
  }
  const size = pngSize(await fs.readFile(output));
  if (!size) throw new Error(`Page ${n} was not rendered as a valid PNG`);
  return { n, quality, path: `${doc.cache}/page-${n}-${quality}.png`, ...size };
}

export async function textPages(doc) {
  const r = await exec("pdftotext", ["-enc", "UTF-8", "-eol", "unix", doc.pdf, "-"], { timeout: 120000 });
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
    const r = await exec("stat", ["-c", "%Y:%F", "--", path]).catch(() => null);
    if (r?.code !== 0 || !r.stdout.includes("directory")) continue;
    entries.push({ path, name, mtime: Number(r.stdout.split(":")[0]) * 1000 });
  }
  const cutoff = Date.now() - 14 * 86400000;
  const old = entries.filter((entry) => entry.name.startsWith(".tmp-") ? entry.mtime < Date.now() - 86400000 : entry.mtime < cutoff);
  const excess = entries.filter((entry) => !entry.name.startsWith(".tmp-")).sort((a, b) => b.mtime - a.mtime).slice(60);
  for (const entry of new Set([...old, ...excess])) await remove(entry.path, true);
}
