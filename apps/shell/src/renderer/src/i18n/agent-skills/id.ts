import type { zh } from './zh'

export const id = {
  noticeText:
    'Skill kini diaktifkan dan dinonaktifkan di Pengaturan → Skill. Skill di folder skill Claude dan Codex awalnya nonaktif.',
  noticeOpenSettings: 'Buka Pengaturan',
  noticeClose: 'Tutup',
  nextSession: 'Skill yang diubah berlaku mulai sesi berikutnya',
  templateLabel: 'Dokumen yang disimpan sebagai templat',
  templateNone: 'Tanpa templat',
  templateFromTab: 'Terbuka di tab',
  templateFromProject: 'Folder proyek',
  templateUnsaved:
    'Tab ini memiliki perubahan yang belum disimpan. File yang tersimpan menjadi templat.',
  templateChecking: 'Memeriksa konten yang disembunyikan…',
  templateUnknown:
    'Untuk format ini aplikasi tidak dapat memeriksa di sini apakah ada konten yang disembunyikan, jadi dokumen tidak dapat disimpan apa adanya. Buat templat kosong lalu simpan.',
  templateTooLarge: 'Dokumen ini terlalu besar untuk disimpan sebagai templat',
  installTitle: 'AI mengusulkan untuk memasang skill ini',
  installHint:
    'Buka pratinjau untuk melihat isinya, lalu putuskan apakah akan memasangnya. Skill yang dipasang tersedia mulai sesi berikutnya.',
  installOpen: 'Buka pratinjau',
  installDismiss: 'Tutup',
  installDismissed: 'Tidak dipasang',
  installCancel: 'Batal',
  actProposeSkill: 'Usulkan skill',
} satisfies Record<keyof typeof zh, string>
