/**
 * Release helper for the published seuoffice packages, which share one version.
 *
 *   node scripts/seuoffice-release.mjs bump <x.y.z>   set the version in every published package
 *   node scripts/seuoffice-release.mjs check <tag>    fail unless <tag> is npm-v<version> of every published package
 *
 * The npm packages are tagged npm-v<x.y.z>; plain v<x.y.z> tags belong to the desktop app releases.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE_FILES = ['packages/embed/package.json', 'apps/web/package.json']
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

function load(file) {
  const path = resolve(repo, file)
  return { path, json: JSON.parse(readFileSync(path, 'utf8')) }
}

const [command, value] = process.argv.slice(2)

if (command === 'bump') {
  if (!value || !SEMVER.test(value)) {
    console.error('usage: seuoffice-release.mjs bump <x.y.z>')
    process.exit(1)
  }
  for (const file of PACKAGE_FILES) {
    const { path, json } = load(file)
    json.version = value
    writeFileSync(path, `${JSON.stringify(json, null, 2)}\n`)
    console.log(`${json.name} -> ${value}`)
  }
} else if (command === 'check') {
  const expected = value?.replace(/^npm-v/, '')
  if (!value?.startsWith('npm-v') || !expected || !SEMVER.test(expected)) {
    console.error(`tag "${value}" is not npm-v<x.y.z>`)
    process.exit(1)
  }
  const mismatched = PACKAGE_FILES.map(load).filter(({ json }) => json.version !== expected)
  for (const { json } of mismatched)
    console.error(`tag ${value} does not match ${json.name}@${json.version}`)
  if (mismatched.length) process.exit(1)
  console.log(`tag ${value} matches ${PACKAGE_FILES.length} packages`)
} else {
  console.error('usage: seuoffice-release.mjs bump <x.y.z> | check <tag>')
  process.exit(1)
}
