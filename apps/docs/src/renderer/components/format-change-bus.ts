/** Save As format-change confirmation bus, split from FormatChangeHost (component-only
 * module, see toast-bus) so file-actions can ask without importing React code. */
import type { ConversionReport, ReportFeature } from '@genoffice/odt-engine'
import type { DocFormat } from '../../shared/open-file'
import type { StringKey } from '../i18n/locale'

/** localized name of each report feature (the spec's fixed `feature` ids) */
export const REPORT_FEATURE_KEYS: Record<ReportFeature, StringKey> = {
  toc: 'appOdtFeatureToc',
  chart: 'appOdtFeatureChart',
  equation: 'appOdtFeatureEquation',
  shape: 'appOdtFeatureShape',
  textbox: 'appOdtFeatureTextbox',
  columns: 'appOdtFeatureColumns',
  citation: 'appOdtFeatureCitation',
  cross_reference: 'appOdtFeatureCrossReference',
  page_color: 'appOdtFeaturePageColor',
  mirror_margins: 'appOdtFeatureMirrorMargins',
  theme: 'appOdtFeatureTheme',
  comment: 'appOdtFeatureComment',
  revision: 'appOdtFeatureRevision',
  ink: 'appOdtFeatureInk',
  watermark: 'appOdtFeatureWatermark',
  password: 'appOdtFeaturePassword',
  protection: 'appOdtFeatureProtection',
  form_field: 'appOdtFeatureFormField',
  object: 'appOdtFeatureObject',
}

export interface FormatChangeRequest {
  /** the format the document is being saved as */
  to: DocFormat
  /** what changes ('converted') and what is left out ('dropped'); never empty */
  report: ConversionReport
}

type Host = (request: FormatChangeRequest, answer: (confirmed: boolean) => void) => void

let host: Host | null = null

/** Registered by FormatChangeHost on mount; null while unmounted. */
export function setFormatChangeHost(fn: Host | null): void {
  host = fn
}

/** Resolves true when the user confirms the format change; with no host nothing is written. */
export function confirmFormatChange(request: FormatChangeRequest): Promise<boolean> {
  const current = host
  if (!current) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => current(request, resolve))
}
