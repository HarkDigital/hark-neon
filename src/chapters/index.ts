import type { ChapterDef } from '../core/types'

/**
 * The scroll story, in order. `length` is scroll distance in viewport
 * heights; `landing` is where nav jumps land (local progress, on settled
 * copy — keep it clear of the ~6% cut window at each end). Each chapter lives
 * in src/chapters/<id>/ and default-exports a factory returning a Chapter.
 *
 * NEON: one sign shop after hours — Lights On (the shop strikes up, the
 * mark ignites), The Sign Wall (work), Tube Chart (eleven colours of gas,
 * eleven services), Word of Mouth (voices), Short Circuit (security), The
 * Bench (how a sign is bent: the process), The Front Door (contact). The ids are
 * shared with src/core/srContent.ts and the chrome's business names.
 */
export const CHAPTERS: ChapterDef[] = [
  { id: 'hero', label: 'Lights On', length: 2.6, landing: 0, intro: 0.8, load: () => import('./hero/index') },
  { id: 'work', label: 'The Sign Wall', length: 3.8, landing: 0.12, intro: 0.06, load: () => import('./work/index') },
  { id: 'services', label: 'Tube Chart', length: 4.0, landing: 0.08, intro: 0.06, load: () => import('./services/index') },
  { id: 'voices', label: 'Word of Mouth', length: 3.2, landing: 0.06, intro: 0.06, load: () => import('./voices/index') },
  { id: 'shield', label: 'Short Circuit', length: 1.8, landing: 0.45, intro: 0.45, load: () => import('./shield/index') },
  { id: 'process', label: 'The Bench', length: 2.2, landing: 0.17, intro: 0.12, load: () => import('./process/index') },
  { id: 'contact', label: 'The Front Door', length: 1.5, landing: 0.3, intro: 0.3, load: () => import('./contact/index') },
]
