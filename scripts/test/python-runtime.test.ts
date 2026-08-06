import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveRagPython } from '../python-runtime.mjs'

describe('resolveRagPython', () => {
  it('prefers an explicit RAG_PYTHON value', () => {
    expect(resolveRagPython({
      platform: 'darwin',
      projectRoot: '/project',
      env: { RAG_PYTHON: '/custom/python' },
      existsSync: () => true,
    })).toBe('/custom/python')
  })

  it('uses the project virtual environment on macOS when it exists', () => {
    expect(resolveRagPython({
      platform: 'darwin',
      projectRoot: '/project',
      env: {},
      existsSync: (candidate) => candidate === path.join('/project', 'rag-service', '.venv', 'bin', 'python'),
    })).toBe(path.join('/project', 'rag-service', '.venv', 'bin', 'python'))
  })

  it('falls back to python3 on macOS without a project virtual environment', () => {
    expect(resolveRagPython({
      platform: 'darwin',
      projectRoot: '/project',
      env: {},
      existsSync: () => false,
    })).toBe('python3')
  })
})
