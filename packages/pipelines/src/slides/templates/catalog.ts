/**
 * The built-in templates in display order. Adding a template is one import and
 * one array entry; the order here is the order the user sees.
 */
import { blockFrame } from './block-frame'
import { blueProfessional } from './blue-professional'
import type { SlideTemplate } from './contract'
import { coral } from './coral'
import { editorialTriTone } from './editorial-tri-tone'
import { emeraldEditorial } from './emerald-editorial'
import { grove } from './grove'
import { monochrome } from './monochrome'
import { neoGridBold } from './neo-grid-bold'
import { rawGrid } from './raw-grid'
import { signal } from './signal'
import { studio } from './studio'
import { vellum } from './vellum'

export const SLIDE_TEMPLATES: readonly SlideTemplate[] = [
  coral,
  blueProfessional,
  monochrome,
  neoGridBold,
  blockFrame,
  rawGrid,
  studio,
  signal,
  grove,
  editorialTriTone,
  emeraldEditorial,
  vellum,
]
