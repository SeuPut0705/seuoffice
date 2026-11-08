/** Type surface for studio-plugin/read-only.mjs (plain JS, bundled by Vite). */

export declare const READ_ONLY_MODULE: string
export declare const READ_ONLY_ATTRIBUTE: string
export declare const STUDIO_READ_ONLY: boolean
export declare function askedReadOnly(win: Window): boolean
export declare function readOnlyAllows(commandId: string): boolean
export declare function readOnlyDocument<T extends object>(doc: T): T
