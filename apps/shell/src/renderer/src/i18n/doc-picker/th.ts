import type { zh } from './zh'

export const th = {
  docPickTitle: 'แนบจากเอกสาร GenOffice',
  docPickPane: 'อีกบานหน้าต่าง',
  docPickOpen: 'เอกสารที่เปิดอยู่',
  docPickRecent: 'เอกสารล่าสุด',
  docPickEmpty: 'ไม่มีเอกสารให้แนบ',
  docPickMissing: 'ไม่พบไฟล์',
  docPickUnsaved: 'โปรดบันทึกก่อน',
  docPickModified: 'บันทึกก่อนจึงจะแนบได้',
  docPickUnavailable: 'อ่านรายการเอกสารไม่ได้',
  docPickLimit: 'เลือกเอกสารได้สูงสุด 20 รายการ',
  docPickSelected: 'เลือกแล้ว {n} รายการ',
  docPickAttach: 'แนบ',
  docPickCancel: 'ยกเลิก',
  docPickWorking: 'กำลังแนบ…',
} satisfies Record<keyof typeof zh, string>
