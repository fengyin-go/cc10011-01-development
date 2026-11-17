/**
 * 测试运行器：用项目自带 esbuild 把测试文件（含 @ 别名与 .ts 导入）打包成
 * 临时 ESM，再交给 node --test 运行；产物写到系统临时目录，不污染源码树。
 *
 * 不用 esbuild 的 alias 选项：alias 会把 @/ 与相对路径解析成两份模块实例，
 * 模块级开关（如失败注入）会失效。这里用 onResolve 重写到同一条真实路径。
 */
import { build } from 'esbuild'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const entry = process.argv[2]
if (!entry) {
  console.error('用法: node tests/run-esbuild.mjs <test-file>')
  process.exit(2)
}

const srcRoot = resolve('src')
function resolveAt(spec) {
  const base = join(srcRoot, spec.slice(2))
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate
  }
  return `${base}.ts`
}
const aliasPlugin = {
  name: 'at-alias-rewrite',
  setup(buildCtx) {
    buildCtx.onResolve({ filter: /^@\// }, (args) => ({ path: resolveAt(args.path) }))
  },
}

const dir = await mkdtemp(join(tmpdir(), 'sss-test-'))
const outfile = join(dir, 'test-bundle.mjs')

await build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile,
  sourcemap: 'inline',
  plugins: [aliasPlugin],
})

try {
  const { stdout, stderr } = await execFileAsync(process.execPath, ['--test', outfile], {
    env: { ...process.env, NODE_ENV: 'test' },
  })
  process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
} catch (error) {
  process.stdout.write(error.stdout ?? '')
  process.stderr.write(error.stderr ?? '')
  process.exitCode = 1
} finally {
  await rm(dir, { recursive: true, force: true })
}
