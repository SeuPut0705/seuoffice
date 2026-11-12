import type { Lang } from '@genoffice/i18n'
import type { CropEdge } from './image-dialogs'

// Shared accessible names for the crop edge handles, so every edge is reachable
// by keyboard and still announced in the editor's own language.
export const CROP_EDGE_LABELS: Record<Lang, Record<CropEdge, string>> = {
  en: {
    nw: 'Top left edge',
    n: 'Top edge',
    ne: 'Top right edge',
    e: 'Right edge',
    se: 'Bottom right edge',
    s: 'Bottom edge',
    sw: 'Bottom left edge',
    w: 'Left edge',
  },
  ko: {
    nw: '왼쪽 위 가장자리',
    n: '위쪽 가장자리',
    ne: '오른쪽 위 가장자리',
    e: '오른쪽 가장자리',
    se: '오른쪽 아래 가장자리',
    s: '아래쪽 가장자리',
    sw: '왼쪽 아래 가장자리',
    w: '왼쪽 가장자리',
  },
}
