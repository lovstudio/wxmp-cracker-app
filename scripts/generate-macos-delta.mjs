#!/usr/bin/env node

import { createHash } from "node:crypto"
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, sep } from "node:path"
import { spawnSync } from "node:child_process"

const args = parseArgs(process.argv.slice(2))

if (args.help) {
  console.log(`Usage: generate-macos-delta.mjs \\
  --from-version VERSION --to-version VERSION --target TARGET \\
  --from-archive OLD.app.tar.gz --to-archive NEW.app.tar.gz --output FILE.delta`)
  process.exit(0)
}

for (const key of [
  "from-version",
  "to-version",
  "target",
  "from-archive",
  "to-archive",
  "output",
]) {
  if (!args[key]) throw new Error(`Missing --${key}`)
}

const workDir = await mkdtemp(join(tmpdir(), "wxmp-macos-delta-"))

try {
  const oldRoot = join(workDir, "old")
  const newRoot = join(workDir, "new")
  const payloadRoot = join(workDir, "payload")
  await mkdir(oldRoot)
  await mkdir(newRoot)
  await mkdir(payloadRoot)
  extractArchive(args["from-archive"], oldRoot)
  extractArchive(args["to-archive"], newRoot)

  const oldApp = await findAppBundle(oldRoot)
  const newApp = await findAppBundle(newRoot)
  const oldFiles = await listTree(oldApp)
  const newFiles = await listTree(newApp)
  const entries = []
  let index = 0

  for (const path of [
    ...new Set([...oldFiles.keys(), ...newFiles.keys()]),
  ].sort()) {
    const source = oldFiles.get(path)
    const target = newFiles.get(path)

    if (!target) {
      entries.push({
        path,
        op: "delete",
        kind: source.kind,
        sourceSha256: source.sha256 ?? null,
      })
      continue
    }

    if (!source || source.kind !== target.kind) {
      entries.push(
        await createReplacement({ path, target, payloadRoot, index: index++ })
      )
      continue
    }

    if (target.kind === "symlink") {
      if (source.link !== target.link) {
        entries.push({
          path,
          op: "symlink",
          kind: "symlink",
          sourceLink: source.link,
          link: target.link,
        })
      }
      continue
    }

    if (source.sha256 === target.sha256 && source.mode === target.mode) continue

    const patchName = `patches/${index}.bsdiff`
    const patchPath = join(payloadRoot, patchName)
    await mkdir(dirname(patchPath), { recursive: true })
    const result = spawnSync(
      process.env.BSDIFF ?? "bsdiff",
      [source.absolutePath, target.absolutePath, patchPath],
      {
        encoding: "utf8",
      }
    )
    if (result.status !== 0) {
      throw new Error(
        `bsdiff failed for ${path}: ${result.stderr || result.error?.message || "unknown error"}`
      )
    }

    entries.push({
      path,
      op: "patch",
      kind: "file",
      sourceSha256: source.sha256,
      targetSha256: target.sha256,
      patch: patchName,
      mode: target.mode,
    })
    index += 1
  }

  const manifest = {
    schema: 1,
    product: "ai.lovstudio.wxmp-cracker",
    fromVersion: args["from-version"],
    toVersion: args["to-version"],
    target: args.target,
    entries,
  }
  await writeFile(
    join(payloadRoot, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
  createArchive(payloadRoot, args.output)
  console.log(
    JSON.stringify({
      path: args.output,
      size: (await stat(args.output)).size,
      sha256: await sha256File(args.output),
      entries: entries.length,
    })
  )
} finally {
  await rm(workDir, { recursive: true, force: true })
}

function parseArgs(values) {
  const parsed = {}
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]
    if (value === "--help") {
      parsed.help = true
      continue
    }
    if (!value.startsWith("--"))
      throw new Error(`Unexpected argument: ${value}`)
    parsed[value.slice(2)] = values[index + 1]
    index += 1
  }
  return parsed
}

function extractArchive(archive, destination) {
  run("tar", ["-xzf", archive, "-C", destination])
}

function createArchive(source, output) {
  run("tar", ["-czf", output, "-C", source, "."])
}

function run(command, arguments_) {
  const result = spawnSync(command, arguments_, { encoding: "utf8" })
  if (result.status !== 0)
    throw new Error(
      `${command} failed: ${result.stderr || result.error?.message || "unknown error"}`
    )
}

async function findAppBundle(root) {
  const items = await readdir(root, { withFileTypes: true })
  const app = items.find(
    (item) => item.isDirectory() && item.name.endsWith(".app")
  )
  if (!app) throw new Error(`No .app bundle found in ${root}`)
  return join(root, app.name)
}

async function listTree(root) {
  const files = new Map()
  await walk(root, root, files)
  return files
}

async function walk(root, current, files) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolutePath = join(current, entry.name)
    const path = relative(root, absolutePath).split(sep).join("/")
    const details = await lstat(absolutePath)
    if (details.isDirectory()) {
      await walk(root, absolutePath, files)
    } else if (details.isSymbolicLink()) {
      files.set(path, {
        kind: "symlink",
        link: await readlink(absolutePath),
        absolutePath,
      })
    } else if (details.isFile()) {
      files.set(path, {
        kind: "file",
        absolutePath,
        mode: details.mode & 0o777,
        sha256: await sha256File(absolutePath),
      })
    } else {
      throw new Error(`Unsupported app bundle entry: ${path}`)
    }
  }
}

async function createReplacement({ path, target, payloadRoot, index }) {
  if (target.kind === "symlink") {
    return { path, op: "symlink", kind: "symlink", link: target.link }
  }
  const file = `files/${index}`
  const destination = join(payloadRoot, file)
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(target.absolutePath, destination)
  await chmod(destination, target.mode)
  return {
    path,
    op: "add",
    kind: "file",
    file,
    targetSha256: target.sha256,
    mode: target.mode,
  }
}

async function sha256File(path) {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex")
}
