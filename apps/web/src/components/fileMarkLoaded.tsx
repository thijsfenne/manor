import { createFileTreeIconResolver, getBuiltInSpriteSheet } from '@pierre/trees'
import type { ComponentPropsWithoutRef } from 'react'

const icons = createFileTreeIconResolver('complete')
const spriteSheet = getBuiltInSpriteSheet('complete')

const toneByToken: Record<string, string> = {
  astro: 'text-lang-css',
  babel: 'text-lang-js',
  bash: 'text-lang-shell',
  biome: 'text-lang-ts',
  bootstrap: 'text-lang-css',
  browserslist: 'text-lang-js',
  bun: 'text-lang-data',
  c: 'text-lang-ts',
  claude: 'text-lang-html',
  cpp: 'text-lang-ts',
  css: 'text-lang-css',
  database: 'text-lang-sql',
  docker: 'text-lang-html',
  eslint: 'text-lang-css',
  font: 'text-lang-media',
  git: 'text-lang-html',
  go: 'text-lang-react',
  graphql: 'text-lang-media',
  html: 'text-lang-html',
  image: 'text-lang-media',
  javascript: 'text-lang-js',
  json: 'text-lang-data',
  markdown: 'text-lang-doc',
  mcp: 'text-lang-react',
  nextjs: 'text-dim',
  npm: 'text-lang-html',
  oxc: 'text-lang-react',
  postcss: 'text-lang-css',
  prettier: 'text-lang-react',
  python: 'text-lang-py',
  react: 'text-lang-react',
  ruby: 'text-lang-html',
  rust: 'text-lang-html',
  sass: 'text-lang-media',
  svg: 'text-lang-html',
  svelte: 'text-lang-html',
  stylelint: 'text-lang-css',
  swift: 'text-lang-html',
  table: 'text-lang-data',
  tailwind: 'text-lang-react',
  terraform: 'text-lang-css',
  typescript: 'text-lang-ts',
  vite: 'text-lang-css',
  vscode: 'text-lang-ts',
  vue: 'text-lang-doc',
  wasm: 'text-lang-css',
  webpack: 'text-lang-ts',
  yml: 'text-lang-data',
  zig: 'text-lang-html',
  zip: 'text-lang-data',
}

export function fileMark(path: string) {
  const mark = icons.resolveIcon('file-tree-icon-file', path)
  return { ...mark, tone: toneByToken[mark.token ?? ''] ?? 'text-dim' }
}

/** One shared copy of Trees' symbol set. File marks anywhere below it can use the ids. */
export function FileMarkSprite() {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute size-0 overflow-hidden"
      dangerouslySetInnerHTML={{ __html: spriteSheet }}
    />
  )
}

interface FileMarkProps extends Omit<ComponentPropsWithoutRef<'svg'>, 'children' | 'height' | 'width'> {
  path: string
  size?: number
}

/** Trees owns file recognition and glyphs; Manor's tokens keep their theme-aware colour. */
export function FileMark({ path, size = 14, className = '', ...props }: FileMarkProps) {
  const mark = fileMark(path)
  const width = mark.width ?? 16
  const height = mark.height ?? 16

  return (
    <svg
      aria-hidden
      focusable="false"
      viewBox={mark.viewBox ?? `0 0 ${width} ${height}`}
      width={size}
      height={size}
      className={`flex-none ${mark.tone} ${className}`}
      data-file-mark={mark.token}
      {...props}
    >
      <use href={`#${mark.name.replace(/^#/, '')}`} />
    </svg>
  )
}
