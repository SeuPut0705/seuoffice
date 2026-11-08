import type { zh } from './zh'

export const ms = {
  noticeText:
    'Kemahiran kini dihidupkan dan dimatikan dalam Tetapan → Kemahiran. Kemahiran dalam folder kemahiran Claude dan Codex bermula dalam keadaan mati.',
  noticeOpenSettings: 'Buka Tetapan',
  noticeClose: 'Tutup',
  nextSession: 'Kemahiran yang diubah berkuat kuasa mulai sesi seterusnya',
  templateLabel: 'Dokumen yang disimpan sebagai templat',
  templateNone: 'Tiada templat',
  templateFromTab: 'Dibuka dalam tab',
  templateFromProject: 'Folder projek',
  templateUnsaved: 'Tab ini ada perubahan yang belum disimpan. Fail yang disimpan menjadi templat.',
  templateChecking: 'Menyemak kandungan yang disembunyikan…',
  templateUnknown:
    'Bagi format ini aplikasi tidak dapat menyemak di sini sama ada ada kandungan yang disembunyikan, jadi dokumen tidak boleh disimpan seadanya. Buat templat kosong dan simpan.',
  templateTooLarge: 'Dokumen ini terlalu besar untuk disimpan sebagai templat',
  installTitle: 'AI mencadangkan untuk memasang kemahiran ini',
  installHint:
    'Buka pratonton untuk melihat kandungannya, kemudian tentukan sama ada mahu memasangnya. Kemahiran yang dipasang tersedia mulai sesi seterusnya.',
  installOpen: 'Buka pratonton',
  installDismiss: 'Tutup',
  installDismissed: 'Tidak dipasang',
  installCancel: 'Batal',
  actProposeSkill: 'Cadangkan kemahiran',
} satisfies Record<keyof typeof zh, string>
