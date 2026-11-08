import type { ReactNode } from 'react'
import type { AiProviderId } from '@genoffice/ai-provider/browser'

// ── AI provider marks (settings provider picker, composer model chip) ──
// No vendor logos: a provider is named in text beside its mark, and the marks
// are three generic glyphs drawn here (see docs/standards.md "상표와 아이콘"):
// a terminal for the Codex subscription, a key for every API-key provider, and
// sliders for the "custom" endpoint, which the Claude subscription shares.
// Every mark uses currentColor so it follows the theme.

const terminalMark = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="2.5" y="4" width="19" height="16" rx="2.5" />
    <path d="m7 9 3 3-3 3M12.5 15H17" />
  </svg>
)

const keyMark = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <circle cx="8" cy="15" r="4.5" />
    <path d="m11.2 11.8 8.3-8.3M16.5 6.5l2.5 2.5M14 9l2 2" />
  </svg>
)

const customMark = (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    aria-hidden="true"
  >
    <path d="M3 6.5h8M15 6.5h6M3 12h3M10 12h11M3 17.5h11M18 17.5h3" />
    <circle cx="13" cy="6.5" r="2" />
    <circle cx="8" cy="12" r="2" />
    <circle cx="16" cy="17.5" r="2" />
  </svg>
)

function markFor(id: string): ReactNode {
  const provider = id as AiProviderId
  if (provider === 'codex') return terminalMark
  // named in text only, no vendor mark
  if (provider === 'claude-code' || provider === 'custom') return customMark
  return keyMark
}

/** Inline provider mark sized by the surrounding container (default `.gs-provider-logo`). */
export function ProviderLogo({
  id,
  className = 'gs-provider-logo',
}: {
  id: string
  className?: string
}) {
  return (
    <span className={className} aria-hidden="true">
      {markFor(id)}
    </span>
  )
}
