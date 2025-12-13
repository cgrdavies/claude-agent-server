import { join, dirname } from 'path'
import { homedir } from 'os'
import { mkdir, unlink, rm, readdir } from 'node:fs/promises'

import { WORKSPACE_DIR_NAME } from './const'

const workspaceDirectory = join(homedir(), WORKSPACE_DIR_NAME)

/**
 * File entry info matching E2B's EntryInfo for compatibility
 */
export type EntryInfo = {
  name: string
  path: string
  type: 'file' | 'dir'
}

/**
 * Resolve a path relative to the workspace directory
 */
export function resolvePath(path: string): string {
  if (path.startsWith('/')) {
    return path
  }
  if (path === '.') {
    return workspaceDirectory
  }
  return join(workspaceDirectory, path)
}

/**
 * Ensure a directory exists, creating parent directories as needed
 */
async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true })
}

/**
 * Write content to a file
 */
export async function writeFile(
  path: string,
  content: string | Blob,
): Promise<void> {
  const resolvedPath = resolvePath(path)
  // Ensure parent directory exists
  await ensureDir(dirname(resolvedPath))
  await Bun.write(resolvedPath, content)
}

/**
 * Read file content as text or blob
 */
export async function readFile(
  path: string,
  format: 'text' | 'blob',
): Promise<string | Blob> {
  const resolvedPath = resolvePath(path)
  const file = Bun.file(resolvedPath)

  if (!(await file.exists())) {
    throw new Error(`File not found: ${path}`)
  }

  if (format === 'blob') {
    return file.slice()
  }
  return file.text()
}

/**
 * Remove a file or directory
 */
export async function removeFile(path: string): Promise<void> {
  const resolvedPath = resolvePath(path)
  const file = Bun.file(resolvedPath)

  if (!(await file.exists())) {
    // Check if it's a directory
    try {
      await rm(resolvedPath, { recursive: true })
      return
    } catch {
      throw new Error(`Path not found: ${path}`)
    }
  }

  const stat = await file.stat()
  if (stat?.isDirectory) {
    await rm(resolvedPath, { recursive: true })
  } else {
    await unlink(resolvedPath)
  }
}

/**
 * List directory contents
 */
export async function listFiles(path: string): Promise<EntryInfo[]> {
  const resolvedPath = resolvePath(path)

  try {
    const entries = await readdir(resolvedPath, { withFileTypes: true })
    return entries.map(entry => ({
      name: entry.name,
      path: join(resolvedPath, entry.name),
      type: entry.isDirectory() ? 'dir' : 'file',
    }))
  } catch (error) {
    throw new Error(`Cannot list directory: ${path}`)
  }
}

/**
 * Create a directory
 */
export async function makeDir(path: string): Promise<void> {
  const resolvedPath = resolvePath(path)
  await mkdir(resolvedPath, { recursive: true })
}

/**
 * Check if a file or directory exists
 */
export async function exists(path: string): Promise<boolean> {
  const resolvedPath = resolvePath(path)

  // Check as file first
  const file = Bun.file(resolvedPath)
  if (await file.exists()) {
    return true
  }

  // Check as directory
  try {
    await readdir(resolvedPath)
    return true
  } catch {
    return false
  }
}
