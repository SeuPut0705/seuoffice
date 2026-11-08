/**
 * Stand-in for the renderer's template-fonts module in the web build. The desktop app registers
 * design-template fonts served over its own URL scheme; a FontFace built from a URL starts
 * downloading at once, so the web build registers none and a document naming one of those families
 * falls back along the grid's font chain.
 */
export const registerTemplateFonts = (): string[] => []
