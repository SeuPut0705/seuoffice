import type { zh } from './zh'

export const th = {
  noticeText:
    'ตอนนี้เปิดและปิดสกิลได้ที่ การตั้งค่า → สกิล สกิลในโฟลเดอร์สกิลของ Claude และ Codex จะเริ่มต้นในสถานะปิด',
  noticeOpenSettings: 'เปิดการตั้งค่า',
  noticeClose: 'ปิด',
  nextSession: 'สกิลที่เปลี่ยนจะมีผลตั้งแต่เซสชันถัดไป',
  templateLabel: 'เอกสารที่จะบันทึกเป็นแม่แบบ',
  templateNone: 'ไม่มีแม่แบบ',
  templateFromTab: 'เปิดอยู่ในแท็บ',
  templateFromProject: 'โฟลเดอร์โปรเจกต์',
  templateUnsaved: 'แท็บนี้มีการแก้ไขที่ยังไม่ได้บันทึก ไฟล์ที่บันทึกไว้จะเป็นแม่แบบ',
  templateChecking: 'กำลังตรวจว่ามีเนื้อหาที่ซ่อนไว้หรือไม่…',
  templateUnknown:
    'รูปแบบนี้ตรวจที่นี่ไม่ได้ว่ามีเนื้อหาที่ซ่อนไว้หรือไม่ จึงบันทึกตามเดิมไม่ได้ โปรดสร้างแม่แบบเปล่าแล้วบันทึก',
  templateTooLarge: 'เอกสารนี้ใหญ่เกินกว่าจะบันทึกเป็นแม่แบบ',
  installTitle: 'AI เสนอให้ติดตั้งสกิลนี้',
  installHint:
    'เปิดตัวอย่างเพื่อดูเนื้อหาก่อน แล้วจึงตัดสินใจว่าจะติดตั้งหรือไม่ สกิลที่ติดตั้งจะใช้ได้ตั้งแต่เซสชันถัดไป',
  installOpen: 'เปิดตัวอย่าง',
  installDismiss: 'ปิด',
  installDismissed: 'ไม่ได้ติดตั้ง',
  installCancel: 'ยกเลิก',
  actProposeSkill: 'เสนอสกิล',
} satisfies Record<keyof typeof zh, string>
