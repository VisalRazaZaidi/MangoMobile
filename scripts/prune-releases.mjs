import { readdirSync, readFileSync, unlinkSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const release = join(root, 'release')
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const current = `MangoMobile-${version}-x64-`
for (const target of ['setup.exe', 'portable.exe']) {
  if (!existsSync(join(release, current + target))) throw new Error('Both new installers must exist before pruning older releases')
}
for (const name of readdirSync(release)) {
  if (/^MangoMobile-\d+\.\d+\.\d+-x64-(setup|portable)\.exe(\.blockmap)?$/.test(name) && !name.startsWith(current)) {
    unlinkSync(join(release, name))
    console.log(`Removed old release: ${name}`)
  }
}
