/**
 * Folder manager unit tests.
 *
 * Tests the validation functions that don't require database access:
 * - validateFolderName() - name validation
 *
 * Integration tests for database operations (createFolder, deleteFolder, etc.)
 * will be added in Phase 4 as part of the folders API tests.
 */

import { describe, test, expect } from 'bun:test'
import { validateFolderName } from '../folder-manager'

describe('Folder Manager - Validation', () => {
  describe('validateFolderName', () => {
    test('accepts valid folder names', () => {
      expect(() => validateFolderName('Documents')).not.toThrow()
      expect(() => validateFolderName('My Folder')).not.toThrow()
      expect(() => validateFolderName('folder-with-dashes')).not.toThrow()
      expect(() => validateFolderName('folder_with_underscores')).not.toThrow()
      expect(() => validateFolderName('folder.with.dots')).not.toThrow()
      expect(() => validateFolderName('123')).not.toThrow()
      expect(() => validateFolderName('Folder (1)')).not.toThrow()
    })

    test('rejects empty folder names', () => {
      expect(() => validateFolderName('')).toThrow('Folder name cannot be empty')
      expect(() => validateFolderName('   ')).toThrow('Folder name cannot be empty')
      expect(() => validateFolderName('\t\n')).toThrow('Folder name cannot be empty')
    })

    test('rejects folder names exceeding max length', () => {
      const longName = 'a'.repeat(101)
      expect(() => validateFolderName(longName)).toThrow('Folder name cannot exceed 100 characters')

      // Exactly 100 chars should be OK
      const maxName = 'a'.repeat(100)
      expect(() => validateFolderName(maxName)).not.toThrow()
    })

    test('rejects folder names with invalid characters', () => {
      // Filesystem-unsafe characters
      expect(() => validateFolderName('folder<name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder>name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder:name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder"name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder/name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder\\name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder|name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder?name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder*name')).toThrow('Folder name contains invalid characters')
    })

    test('rejects folder names with control characters', () => {
      expect(() => validateFolderName('folder\x00name')).toThrow('Folder name contains invalid characters')
      expect(() => validateFolderName('folder\x1fname')).toThrow('Folder name contains invalid characters')
    })

    test('accepts unicode characters', () => {
      expect(() => validateFolderName('文件夹')).not.toThrow()
      expect(() => validateFolderName('Dossier')).not.toThrow()
      expect(() => validateFolderName('папка')).not.toThrow()
      expect(() => validateFolderName('📁 folder')).not.toThrow()
    })

    test('accepts names with leading/trailing spaces', () => {
      // Leading/trailing spaces are OK (will be trimmed on save)
      expect(() => validateFolderName('  folder  ')).not.toThrow()
    })

    test('rejects names with tabs (control characters)', () => {
      // Tabs are control characters (0x09) and should be rejected
      expect(() => validateFolderName('\tfolder\t')).toThrow('Folder name contains invalid characters')
    })
  })
})
