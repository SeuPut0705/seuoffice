import { PRODUCT_REPO_NAME, PRODUCT_REPO_OWNER, PRODUCT_REPO_SLUG } from '@genoffice/i18n'

// Repository coordinates. Owner and repo are defined once, in the product
// identity module of @genoffice/i18n (which renderers can import too); every
// repository, issue and release link is derived from them here.
export const GITHUB_REPO_OWNER = PRODUCT_REPO_OWNER
export const GITHUB_REPO_NAME = PRODUCT_REPO_NAME
/** `owner/repo`, as GitHub tooling and the REST API paths spell it */
export const GITHUB_REPO_SLUG = PRODUCT_REPO_SLUG
/** the public open-source repository */
export const GITHUB_REPO_URL = `https://github.com/${GITHUB_REPO_SLUG}`
/** the repository address as shown to the user (no scheme) */
export const GITHUB_REPO_DISPLAY = `github.com/${GITHUB_REPO_SLUG}`
/** issue tracker, and the form that reports a new problem */
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_ISSUES_URL}/new`
/** every published version, and the page a manual download starts from */
export const GITHUB_RELEASES_URL = `${GITHUB_REPO_URL}/releases`
export const GITHUB_LATEST_RELEASE_URL = `${GITHUB_RELEASES_URL}/latest`

/** release page of one version; tags are the version with a leading "v" */
export function githubReleaseTagUrl(version: string): string {
  return `${GITHUB_RELEASES_URL}/tag/v${version.replace(/^v/, '')}`
}
