/** How many attachment names one prompt line carries; the panel caps attachments anyway. */
const MAX_NAMES = 20

/**
 * One line for a skill's system prompt naming the image files the user attached to this
 * chat, or `''` when there are none. Image-insertion tools take the exact file name, and
 * the model only sees the images themselves (no metadata), so without this line it can
 * only guess a name. A guessed name resolves to nothing, but the user then sees a failed
 * insertion for a picture they did attach.
 *
 * `placement` is the sentence half after "To put one in the document, " — each editor names
 * its own tool (`insert_image`, `add_image`, `insert_web_image`, `apply_ops`).
 */
export function attachedImageNote(names: readonly string[], placement: string): string {
  const unique: string[] = []
  for (const raw of names) {
    const name = raw.trim()
    if (!name || unique.includes(name)) continue
    unique.push(name)
  }
  if (unique.length === 0) return ''
  const shown = unique.slice(0, MAX_NAMES)
  const rest = unique.length > shown.length ? ` (and ${unique.length - shown.length} more)` : ''
  return `\n\nImages attached to this chat${rest}: ${shown.join(', ')}. To put one in the document, ${placement}; use the exact name.`
}
