import type { zh } from './zh'

export const th = {
  pageSelDelete: 'ลบ {n} หน้า',
  pageSelExtract: 'แยก {n} หน้า',
  pageCut: 'ตัด',
  pageCopy: 'คัดลอก',
  pagePaste: 'วาง',
  pagesCopied: 'คัดลอกแล้ว {n} หน้า',
  pagesCut: 'ตัดแล้ว {n} หน้า',
  pagesPasted: 'วางแล้ว {n} หน้า',
  pageClipEmpty: 'ยังไม่มีหน้าที่คัดลอก เลือกหน้าในภาพขนาดย่อแล้วคัดลอกก่อน จากนั้นจึงวาง',
  pageClipProtected: 'ไม่สามารถคัดลอกหรือวางหน้าใน PDF ที่ป้องกันด้วยรหัสผ่านได้',
} satisfies Record<keyof typeof zh, string>
