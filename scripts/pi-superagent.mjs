#!/usr/bin/env node
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = new URL('../', import.meta.url)
const environment = fileURLToPath(new URL('.env', root))
if (existsSync(environment)) process.loadEnvFile(environment)
const entry = new URL('dist/cli.js', root)
if (!existsSync(entry)) {
  console.error('尚未构建，请在仓库中运行 npm install 和 npm run build。')
  process.exitCode = 1
} else {
  await import(entry.href)
}
