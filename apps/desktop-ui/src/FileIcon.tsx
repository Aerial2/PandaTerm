import {
  File,
  FileText,
  FileType2,
  Code2,
  Image,
  Music,
  Video,
  Database,
  Archive,
  Settings,
  Shield,
  Package,
  TerminalSquare,
  Braces,
  Hash,
  Coffee,
  Palette,
  Binary,
  Cog,
  Layout,
  Globe,
  GitBranch,
  Puzzle,
  BookOpen,
  FlaskConical,
  Wrench,
  Box,
  FolderOpen,
  ListChecks,
  Lock,
  Moon,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type FileIconInfo = {
  icon: LucideIcon;
  color: string;
};

/** Map file extensions to icon + color, inspired by vscode-icons */
const extensionMap: Record<string, FileIconInfo> = {
  // JavaScript / TypeScript
  js: { icon: Braces, color: '#f7df1e' },
  jsx: { icon: Braces, color: '#61dafb' },
  ts: { icon: Code2, color: '#3178c6' },
  tsx: { icon: Code2, color: '#3178c6' },
  mjs: { icon: Braces, color: '#f7df1e' },
  cjs: { icon: Braces, color: '#f7df1e' },

  // Web
  html: { icon: Globe, color: '#e34c26' },
  htm: { icon: Globe, color: '#e34c26' },
  css: { icon: Palette, color: '#563d7c' },
  scss: { icon: Palette, color: '#cf649a' },
  sass: { icon: Palette, color: '#cf649a' },
  less: { icon: Palette, color: '#1d365d' },
  vue: { icon: Layout, color: '#42b883' },
  svelte: { icon: Layout, color: '#ff3e00' },

  // Python
  py: { icon: Braces, color: '#3572a5' },
  pyw: { icon: Braces, color: '#3572a5' },
  pyc: { icon: Binary, color: '#3572a5' },

  // Rust
  rs: { icon: Cog, color: '#dea584' },
  toml: { icon: Settings, color: '#dea584' },

  // Go
  go: { icon: Code2, color: '#00add8' },

  // Java / Kotlin
  java: { icon: Coffee, color: '#b07219' },
  kt: { icon: Braces, color: '#a97bff' },
  kts: { icon: Braces, color: '#a97bff' },
  gradle: { icon: Wrench, color: '#02303a' },

  // C / C++
  c: { icon: Hash, color: '#555555' },
  h: { icon: Hash, color: '#555555' },
  cpp: { icon: Hash, color: '#f34b7d' },
  cc: { icon: Hash, color: '#f34b7d' },
  cxx: { icon: Hash, color: '#f34b7d' },
  hpp: { icon: Hash, color: '#f34b7d' },
  hh: { icon: Hash, color: '#f34b7d' },

  // Ruby
  rb: { icon: Braces, color: '#701516' },
  gemspec: { icon: Package, color: '#701516' },

  // Swift
  swift: { icon: Code2, color: '#fa7343' },

  // Shell
  sh: { icon: TerminalSquare, color: '#89e051' },
  bash: { icon: TerminalSquare, color: '#89e051' },
  zsh: { icon: TerminalSquare, color: '#89e051' },
  fish: { icon: TerminalSquare, color: '#89e051' },
  bat: { icon: TerminalSquare, color: '#c1f12e' },
  cmd: { icon: TerminalSquare, color: '#c1f12e' },
  ps1: { icon: TerminalSquare, color: '#012456' },

  // Data / Config
  json: { icon: Braces, color: '#f7df1e' },
  yaml: { icon: FileText, color: '#cb171e' },
  yml: { icon: FileText, color: '#cb171e' },
  xml: { icon: Code2, color: '#e37933' },
  ini: { icon: Settings, color: '#6d8086' },
  cfg: { icon: Settings, color: '#6d8086' },
  conf: { icon: Settings, color: '#6d8086' },
  env: { icon: Shield, color: '#ecd53f' },

  // Database
  sql: { icon: Database, color: '#e38c00' },
  db: { icon: Database, color: '#e38c00' },
  sqlite: { icon: Database, color: '#008c01' },

  // Markdown / Docs
  md: { icon: BookOpen, color: '#519aba' },
  mdx: { icon: BookOpen, color: '#519aba' },
  txt: { icon: FileText, color: '#89e051' },
  pdf: { icon: FileType2, color: '#b30b00' },
  doc: { icon: FileText, color: '#1856a8' },
  docx: { icon: FileText, color: '#1856a8' },
  rtf: { icon: FileText, color: '#8c6dab' },

  // Images
  png: { icon: Image, color: '#a074c4' },
  jpg: { icon: Image, color: '#a074c4' },
  jpeg: { icon: Image, color: '#a074c4' },
  gif: { icon: Image, color: '#a074c4' },
  svg: { icon: Image, color: '#f7df1e' },
  ico: { icon: Image, color: '#cbcb41' },
  webp: { icon: Image, color: '#a074c4' },
  bmp: { icon: Image, color: '#a074c4' },
  avif: { icon: Image, color: '#a074c4' },

  // Audio
  mp3: { icon: Music, color: '#1db954' },
  wav: { icon: Music, color: '#1db954' },
  ogg: { icon: Music, color: '#1db954' },
  flac: { icon: Music, color: '#1db954' },
  aac: { icon: Music, color: '#1db954' },

  // Video
  mp4: { icon: Video, color: '#e5a00d' },
  mkv: { icon: Video, color: '#e5a00d' },
  avi: { icon: Video, color: '#e5a00d' },
  mov: { icon: Video, color: '#e5a00d' },
  webm: { icon: Video, color: '#e5a00d' },
  flv: { icon: Video, color: '#e5a00d' },

  // Archives
  zip: { icon: Archive, color: '#6d8086' },
  tar: { icon: Archive, color: '#6d8086' },
  gz: { icon: Archive, color: '#6d8086' },
  bz2: { icon: Archive, color: '#6d8086' },
  rar: { icon: Archive, color: '#6d8086' },
  '7z': { icon: Archive, color: '#6d8086' },
  xz: { icon: Archive, color: '#6d8086' },

  // Docker / DevOps
  dockerfile: { icon: Box, color: '#2496ed' },

  // Git
  gitignore: { icon: GitBranch, color: '#f54d27' },
  gitattributes: { icon: GitBranch, color: '#f54d27' },
  gitmodules: { icon: GitBranch, color: '#f54d27' },

  // Lock / Package
  lock: { icon: Lock, color: '#6d8086' },
  packagejson: { icon: Package, color: '#e8274b' },
  package_lockjson: { icon: Package, color: '#6d8086' },
  npmrc: { icon: Settings, color: '#cb3837' },

  // Misc
  log: { icon: FileText, color: '#89e051' },
  csv: { icon: FileText, color: '#89e051' },
  tsv: { icon: FileText, color: '#89e051' },
  diff: { icon: FileText, color: '#427519' },
  patch: { icon: FileText, color: '#427519' },

  // Lua
  lua: { icon: Moon, color: '#000080' },

  // PHP
  php: { icon: Braces, color: '#4f5d95' },

  // Dart
  dart: { icon: Code2, color: '#00b4ab' },

  // Elm
  elm: { icon: Puzzle, color: '#60b5cc' },

  // Elixir / Erlang
  ex: { icon: Code2, color: '#6e4a7e' },
  exs: { icon: Code2, color: '#6e4a7e' },
  erl: { icon: Code2, color: '#b83998' },

  // Haskell
  hs: { icon: Code2, color: '#5e5086' },

  // R
  r: { icon: Braces, color: '#198ce7' },

  // Julia
  jl: { icon: Code2, color: '#9558b2' },

  // Perl
  pl: { icon: Braces, color: '#0298c3' },
  pm: { icon: Braces, color: '#0298c3' },

  // Scala
  scala: { icon: Code2, color: '#c22d33' },

  // .NET
  cs: { icon: Code2, color: '#178600' },
  csx: { icon: Code2, color: '#178600' },
  vb: { icon: Code2, color: '#945db7' },

  // Objective-C
  m: { icon: Code2, color: '#438eff' },
  mm: { icon: Code2, color: '#438eff' },

  // Make
  makefile: { icon: Wrench, color: '#6d8086' },
  cmake: { icon: Wrench, color: '#064f8c' },
};

/** Special filenames (without extension) */
const filenameMap: Record<string, FileIconInfo> = {
  dockerfile: { icon: Box, color: '#2496ed' },
  makefile: { icon: Wrench, color: '#6d8086' },
  gemfile: { icon: Package, color: '#701516' },
  gemfilelock: { icon: Package, color: '#701516' },
  vagrantfile: { icon: Settings, color: '#15bfff' },
  readme: { icon: BookOpen, color: '#519aba' },
  license: { icon: Shield, color: '#d4a017' },
  licence: { icon: Shield, color: '#d4a017' },
  changelog: { icon: BookOpen, color: '#519aba' },
  todo: { icon: ListChecks, color: '#427519' },
  contributing: { icon: BookOpen, color: '#519aba' },
  webpackconfigjs: { icon: Settings, color: '#8dd6f9' },
  tsconfigjson: { icon: Settings, color: '#3178c6' },
  packagejson: { icon: Package, color: '#e8274b' },
  package_lockjson: { icon: Package, color: '#6d8086' },
  cargo_toml: { icon: Settings, color: '#dea584' },
  cargo_lock: { icon: Settings, color: '#dea584' },
  gitignore: { icon: GitBranch, color: '#f54d27' },
  gitattributes: { icon: GitBranch, color: '#f54d27' },
  gitmodules: { icon: GitBranch, color: '#f54d27' },
  npmrc: { icon: Settings, color: '#cb3837' },
  envrc: { icon: Shield, color: '#ecd53f' },
  editorconfig: { icon: Settings, color: '#fff2f0' },
  prettierrc: { icon: Settings, color: '#56b3b2' },
  eslintrcjs: { icon: Settings, color: '#4b32c3' },
  eslintrcjson: { icon: Settings, color: '#4b32c3' },
  eslintrccjs: { icon: Settings, color: '#4b32c3' },
  babelrc: { icon: Settings, color: '#f7df1e' },
  jestconfigjs: { icon: FlaskConical, color: '#c21325' },
  viteconfigts: { icon: Settings, color: '#bd34fe' },
  nextconfigjs: { icon: Settings, color: '#000' },
  tailwindconfigjs: { icon: Palette, color: '#38bdf8' },
  postcssconfigjs: { icon: Settings, color: '#dd3a0a' },
};

/** Get extension from filename (lowercase, without dot) */
function getExtension(filename: string): string {
  const dotIndex = filename.lastIndexOf('.');
  if (dotIndex === -1) return '';
  return filename.slice(dotIndex + 1).toLowerCase();
}

/** Normalize filename for special lookup: strip dots, lowercase */
function normalizeFilename(filename: string): string {
  return filename.toLowerCase().replace(/\./g, '').replace(/\-/g, '');
}

export function getFileIconInfo(filename: string, isDirectory: boolean): FileIconInfo {
  if (isDirectory) {
    return { icon: FolderOpen, color: '#e8a641' };
  }

  // Check special filenames first
  const norm = normalizeFilename(filename);
  if (filenameMap[norm]) {
    return filenameMap[norm];
  }

  // Check by extension
  const ext = getExtension(filename);
  if (ext && extensionMap[ext]) {
    return extensionMap[ext];
  }

  // Composite extensions (e.g. .tar.gz, .d.ts)
  if (ext === 'gz' || ext === 'xz' || ext === 'bz2') {
    const base = getExtension(filename.slice(0, filename.lastIndexOf('.')));
    if (base === 'tar') return { icon: Archive, color: '#6d8086' };
  }
  if (ext === 'ts') {
    const base = getExtension(filename.slice(0, filename.lastIndexOf('.')));
    if (base === 'd') return { icon: FileText, color: '#3178c6' };
  }

  // Fallback
  return { icon: File, color: '#6b7b8d' };
}

export function VscodeFileIcon({ filename, isDirectory, size = 18 }: { filename: string; isDirectory: boolean; size?: number }) {
  const info = getFileIconInfo(filename, isDirectory);
  return <info.icon size={size} style={{ color: info.color }} />;
}
