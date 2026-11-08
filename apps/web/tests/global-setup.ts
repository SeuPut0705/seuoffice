import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** The xlsx fixtures are generated, not committed */
export default function globalSetup(): void {
  execFileSync('npm', ['run', 'fixtures', '-w', '@genoffice/sheets'], {
    cwd: fileURLToPath(new URL('../../..', import.meta.url)),
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
}
