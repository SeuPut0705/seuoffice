/**
 * Product identity: the ONE place the user-visible product name, the names
 * derived from it, and the public repository are defined.
 *
 * Dictionaries, help topics and prompts write the product name directly. The
 * one string that names the original work, the "based on GenOffice"
 * acknowledgement, takes it as the `{upstream}` parameter, filled with
 * UPSTREAM_PRODUCT_NAME, so the literal lives here and nowhere else.
 */

/** The open-source project this product is based on (Apache-2.0, see NOTICE). Shown in the acknowledgement. */
export const UPSTREAM_PRODUCT_NAME = 'GenOffice'

/**
 * The product name in every language without a localized one. Also the name
 * the installer registers on the user's machine (its productName, the default
 * save folder), which must stay the same whatever the UI language is. The
 * userData folder and keychain name are USER_DATA_DIR_NAME, not this.
 */
export const PRODUCT_NAME = 'SeuOffice'

/**
 * Languages that show a localized product name instead of PRODUCT_NAME.
 * SeuOffice has no localized name yet, so every language shows PRODUCT_NAME.
 */
const LOCALIZED_PRODUCT_NAMES: Readonly<Record<string, string>> = {}

/** The product name as shown in a UI language (a Lang or a raw locale tag). */
export function productName(lang: string | null | undefined): string {
  const base = lang?.trim().toLowerCase().split(/[-_]/)[0] ?? ''
  return Object.hasOwn(LOCALIZED_PRODUCT_NAMES, base)
    ? LOCALIZED_PRODUCT_NAMES[base]!
    : PRODUCT_NAME
}

/**
 * The machine name of the installed app: the userData folder under the per-user
 * app-data root, and (through app.setName) the macOS keychain item
 * "<name> Safe Storage" that holds the key for stored secrets. Spelled as in
 * v0.12.11, not derived from PRODUCT_NAME: an updated install must keep finding
 * its profile, its keychain key, and the absolute paths saved under it, and
 * macOS keychain lookups and path comparisons in the app are case-sensitive.
 */
export const USER_DATA_DIR_NAME = 'seuoffice'

/** userData folder name of an unpacked (development) run, kept apart from the installed app's. */
export const DEV_USER_DATA_DIR_NAME = `${USER_DATA_DIR_NAME}-Dev`

/** The product's public GitHub repository: issues, releases and update checks all point here. */
export const PRODUCT_REPO_OWNER = 'seuput-inc'
export const PRODUCT_REPO_NAME = 'seuoffice'
/** `owner/repo`; the URLs built from it live in @seuoffice/electron-utils (github-menu.ts) */
export const PRODUCT_REPO_SLUG = `${PRODUCT_REPO_OWNER}/${PRODUCT_REPO_NAME}`
