/**
 * Font install action. Main pushes the relaid-out slides via deck-changed and a
 * fonts-changed ping after a successful install, so callers only need the
 * installed family names.
 */
export async function installLocalFonts(): Promise<string[]> {
  try {
    const r = await window.slidesApi.fontInstallLocal?.()
    return r?.families ?? []
  } catch {
    return []
  }
}
