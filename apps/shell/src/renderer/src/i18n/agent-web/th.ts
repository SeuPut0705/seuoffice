import type { zh } from './zh'

export const th = {
  actWebSearch: 'ค้นหาเว็บ',
  actWebFetch: 'อ่านหน้าเว็บ',
  permWebSearch: 'ค้นหาบนเว็บ',
  permWebFetch: 'อ่านหน้าเว็บนี้',
  permAllowSearchSession: 'อนุญาตการค้นหาตลอดเซสชันนี้',
  permAllowSiteSession: 'อนุญาตเว็บไซต์นี้ตลอดเซสชันนี้',
  codexWebLabel: 'ค้นหาเว็บ',
  codexWebCached: 'ผลลัพธ์ที่บันทึกไว้',
  codexWebLive: 'แบบเรียลไทม์',
  codexWebDisabled: 'ปิด',
  codexWebNote:
    'ผลลัพธ์ที่บันทึกไว้มาจากข้อมูลเว็บที่รวบรวมไว้ล่วงหน้า ส่วนแบบเรียลไทม์จะค้นหาเว็บในขณะนี้',
  codexNetworkLabel: 'การเชื่อมต่ออินเทอร์เน็ตของคำสั่ง',
  codexNetworkOff: 'ปิด',
  codexNetworkOn: 'เปิด',
  codexNetworkWarning:
    'เมื่อเปิด คำสั่งที่ Codex เรียกใช้จะเข้าถึงอินเทอร์เน็ตได้ ในโหมด “เชื่อถือโปรเจกต์นี้” จะเข้าถึงได้โดยไม่ถาม คำสั่งที่ซ่อนอยู่ในเอกสารที่ได้รับมาอาจทำให้ข้อมูลของคุณถูกส่งออกไปภายนอก',
  codexFolderNote: 'การตั้งค่าทั้งสองนี้จะถูกจำแยกตามโฟลเดอร์โปรเจกต์',
  providerCodexNoteWeb:
    'คำสั่งจะทำงานในพื้นที่แยกของ Codex เขียนได้เฉพาะในโฟลเดอร์โปรเจกต์ และใช้อินเทอร์เน็ตไม่ได้เว้นแต่คุณจะเปิดไว้',
} satisfies Record<keyof typeof zh, string>
