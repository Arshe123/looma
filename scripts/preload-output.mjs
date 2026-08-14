import path from 'node:path'

export const preloadOutputCandidates = outDir => [
  path.join(outDir, 'preload', 'index.js'),
  path.join(outDir, 'preload.js'),
  path.join(outDir, 'index.js'),
]

export const resolvePreloadOutput = (outDir, existsSync) =>
  preloadOutputCandidates(outDir).find(candidate => existsSync(candidate)) ?? null
