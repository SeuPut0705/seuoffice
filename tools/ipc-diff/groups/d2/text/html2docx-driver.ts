/** html2docx's Electron driver: the hidden window is the Rust host's, so nothing is opened */
export class ElectronBrowserDriver {
  static async create(): Promise<ElectronBrowserDriver> {
    return new ElectronBrowserDriver()
  }
  isWindowDestroyed(): boolean {
    return false
  }
  destroyNow(): void {}
  async close(): Promise<void> {}
}
