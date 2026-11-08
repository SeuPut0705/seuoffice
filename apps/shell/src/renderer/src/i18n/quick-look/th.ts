import type { zh } from './zh'

export const th = {
  windowTitle: 'ดูตัวอย่างด่วน',
  openInEditor: 'เปิดใน GenOffice',
  revealInFolder: 'แสดงในโฟลเดอร์',
  close: 'ปิด',
  prevFile: 'ไฟล์ก่อนหน้า (↑)',
  nextFile: 'ไฟล์ถัดไป (↓)',
  shortcutHint: 'Space / Esc ปิด · ↑↓ สลับไฟล์ · Enter เปิด',
  loading: 'กำลังโหลดตัวอย่าง…',
  empty: 'เอกสารนี้ไม่มีข้อความที่แสดงตัวอย่างได้',
  encrypted: 'เอกสารป้องกันด้วยรหัสผ่าน เปิดใน GenOffice เพื่อปลดล็อก',
  unsupported: 'รูปแบบไฟล์นี้ไม่สามารถแสดงตัวอย่างโดยตรงได้',
  failed: 'ไม่สามารถอ่านตัวอย่างไฟล์ได้',
  truncated: 'แสดงเฉพาะส่วนต้นของเอกสาร เปิดใน GenOffice เพื่อดูทั้งหมด',
  slideLabel: 'สไลด์ {n}',
  sheetCount: '{n} ชีต',
  slideCount: '{n} สไลด์',
  lineCount: '{n} บรรทัด',
  charCount: '{n} อักขระ',
  tabThumbnail: 'ภาพตัวอย่าง',
  tabContent: 'เนื้อหาเอกสาร',
  setQuickLookTitle: 'ดูตัวอย่างด่วน (ปุ่ม Spacebar)',
  setQuickLookHint:
    'กด Space บนไฟล์ในรายการของ GenOffice เพื่อดูตัวอย่างเนื้อหาโดยไม่ต้องเปิดแท็บใหม่',
  setExplorerSpace: 'กด Spacebar เพื่อดูตัวอย่างไฟล์ใน Windows File Explorer และเดสก์ท็อป',
  setExplorerSpaceDesc:
    'กด Space บนไฟล์ที่เลือกใน File Explorer หรือเดสก์ท็อปเพื่อเปิดหน้าต่างดูตัวอย่างด่วน',
  setKeepInTray: 'ทำงานต่อในถาดระบบเมื่อปิดหน้าต่าง',
  setKeepInTrayDesc:
    'ให้ GenOffice พร้อมทำงานในพื้นหลังเพื่อให้ดูตัวอย่างด้วย Spacebar ใน File Explorer ได้แม้ปิดหน้าต่างหลักแล้ว',
  trayOpen: 'เปิด GenOffice',
  trayQuit: 'ออกจาก GenOffice',
} satisfies Record<keyof typeof zh, string>
