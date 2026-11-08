# Mode agen

Agen memakai satu folder yang Anda pilih sebagai proyek, lalu menjalankan Claude Code atau Codex dari PC ini di folder tersebut. AI membaca sendiri bahan di dalam folder, membuat file baru, memakai skill dan skrip, serta mengedit dokumen yang terbuka di GenOffice. Gunakan untuk pekerjaan yang membutuhkan banyak bahan.

## Sebelum mulai

- Program Claude Code atau Codex yang terhubung di **Pengaturan ▸ AI** (masuk dengan langganan Claude atau paket ChatGPT). ChatGPT yang terhubung langsung di aplikasi tidak dipakai oleh agen. Topik "Koneksi langganan" menjelaskan caranya.
- Folder berisi bahan Anda. Seluruh drive, seluruh folder pengguna Anda, dan folder berisi data login atau data aplikasi tidak dapat dipilih.

## Memulai sesi

1. Di bilah samping kiri Beranda, klik **Agen**. Jendela agen terbuka tersendiri.
2. Klik **Pilih folder…** untuk memilih folder proyek. Folder yang baru-baru ini Anda pakai tercantum di **Folder terbaru**.
3. Di **Program**, pilih Claude Code atau Codex. Program yang belum terhubung tidak dapat dipilih.
4. Di **Kapan bertanya kepada Anda**, pilih cara agen meminta izin (lihat tabel di bawah).
5. Pada kali pertama, baca **Sebelum mulai** lalu klik **Saya mengerti**.
6. Klik **Mulai**, tulis apa yang ingin dikerjakan, lalu klik **Kirim**.

Satu jendela adalah satu sesi. Menutup jendela atau mengeklik **Hentikan** mengakhiri sesi, dan program yang dijalankan GenOffice untuk sesi itu juga ikut berhenti. Sesi juga berakhir setelah 30 menit tanpa ada yang dikirim.

## Cara agen bertanya

| Pilihan                                            | Langsung dikerjakan                                                      | Ditanyakan dulu                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| **Tanya sebelum setiap perintah** (bawaan)         | Membaca dan menulis file di folder proyek, mengedit dokumen yang terbuka | Menjalankan perintah atau skrip, membaca di luar folder proyek        |
| **Tanya sebelum menulis dan menjalankan perintah** | Membaca file di folder proyek, mengedit dokumen yang terbuka             | Menulis file, menjalankan perintah atau skrip, membaca di luar folder |
| **Percayai proyek ini**                            | Hampir semuanya                                                          | Membaca di luar folder proyek                                         |

Saat agen bertanya, jendela menampilkan apa yang ingin dilakukannya (perintah lengkap, jalur file). Klik **Izinkan** atau **Tolak**.

Apa pun pilihan Anda, agen tidak akan:

- Menimpa file dokumen yang terbuka di tab GenOffice. Dokumen yang terbuka diedit melalui aplikasi, sehingga perubahan langsung terlihat di editor dan bisa dibatalkan dengan Urungkan di editor.
- Menulis di luar folder proyek.
- Menyentuh data login Claude atau Codex, maupun folder data GenOffice.

## Claude Code dan Codex

- **Codex** menjalankan perintah di ruang terisolasinya sendiri, termasuk perintah yang Anda izinkan. Codex hanya dapat menulis di folder proyek, internet diblokir kecuali Anda mengaktifkannya, dan file pribadi Anda di luar proyek tidak dapat dibacanya. Saat sesi dimulai, GenOffice lebih dulu memeriksa apakah isolasi ini berfungsi di PC ini, dan tidak memulai sesi jika tidak berfungsi.
- **Claude Code** tidak dapat mengisolasi perintah di Windows. Perintah yang Anda izinkan dapat menjangkau seluruh PC dan internet. Karena itu, pada **Percayai proyek ini**, pemeriksa milik Claude Code sendiri yang memeriksa setiap tindakan menggantikan Anda.

Dokumen yang dikirim orang lain kepada Anda bisa berisi instruksi tersembunyi yang menyuruh AI melakukan hal lain. Di folder berisi bahan yang tidak Anda kenal, gunakan salah satu pilihan yang bertanya.

## Pencarian web dan internet

- **Claude Code** dapat mencari di web dan membaca halaman web, tetapi bertanya dulu. Claude Code bertanya saat pertama kali mencari, dan untuk setiap situs yang halamannya akan dibaca. Dalam pertanyaan itu, **Izinkan pencarian selama sesi ini** atau **Izinkan situs ini selama sesi ini** membuatnya tidak bertanya lagi sampai sesi berakhir. Pada **Percayai proyek ini**, pemeriksa milik Claude Code sendiri yang memutuskan.
- Saat Anda memilih **Codex**, layar awal menampilkan dua pengaturan tambahan.

| Pengaturan                        | Pilihan                               | Awalnya         |
| --------------------------------- | ------------------------------------- | --------------- |
| **Pencarian web**                 | Hasil tersimpan / Langsung / Nonaktif | Hasil tersimpan |
| **Akses internet untuk perintah** | Nonaktif / Aktif                      | Nonaktif        |

- Hasil tersimpan berasal dari konten web yang dikumpulkan sebelumnya; Langsung mencari web sebagaimana adanya sekarang.
- Kedua pengaturan ini diingat untuk setiap folder proyek. Folder yang baru pertama kali dipakai dimulai dengan nilai di atas.
- Jika akses internet untuk perintah aktif, perintah yang dijalankan Codex dapat menjangkau internet. Pada **Percayai proyek ini**, perintah menjangkaunya tanpa bertanya, dan instruksi tersembunyi dalam dokumen yang Anda terima bisa membuatnya mengirim data Anda keluar. Peringatan ini muncul saat Anda mengaktifkannya. Aktifkan hanya bila diperlukan. Skill bawaan "Cari skill" hanya berfungsi jika pengaturan ini aktif.

## Catatan proyek dan skill

- Jika folder berisi `CLAUDE.md` atau `AGENTS.md`, isinya diberikan kepada agen sebagai instruksi. Tuliskan hal yang harus berlaku setiap kali: nada, istilah, format dokumen yang akan dibuat.
- Jendela agen memakai skill yang diaktifkan di **Pengaturan ▸ Skill**. Claude Code dan Codex mendapat daftar yang sama. Penjelasan lebih lengkap tentang skill ada di [Skill](help://skills).
- Skill di `.claude/skills` dan `.agents/skills` pada folder proyek dipakai dalam sesi itu tanpa perlu diaktifkan.
- Pilih skill dengan `/` atau `$` di kotak input, maka instruksi untuk membaca dan mengikuti skill itu ditempatkan di depan permintaan Anda.
- Daftar skill ditetapkan saat sesi dimulai. Jika Anda mengaktifkan atau menonaktifkan skill selama sesi berjalan, muncul "Skill yang diubah berlaku mulai sesi berikutnya".
- Saat agen membuat skill, kartu skill muncul di jendela; saat agen menemukan skill yang layak dipasang, muncul pratinjau pemasangan. Tidak ada yang disimpan atau dipasang sebelum Anda mengeklik **Simpan** atau **Pasang**, dan skill yang dipasang tersedia mulai sesi berikutnya.
- Program yang dipakai skrip sebuah skill (Python dan sebagainya) harus terpasang di PC ini.
- Jika Anda pernah memakai agen di versi sebelumnya, saat pertama kali membuka jendela agen muncul pemberitahuan satu kali: "Skill kini diaktifkan dan dinonaktifkan di Pengaturan → Skill. Skill di folder skill Claude dan Codex awalnya nonaktif." **Buka Pengaturan** langsung membawa Anda ke sana.

## File baru dan dokumen yang terbuka

- File baru yang dibuat agen disimpan di folder proyek. Klik **Buka** pada baris itu di log kemajuan untuk membuka file di tab GenOffice.
- Agar dokumen yang terbuka diedit, buka dulu dokumen itu di GenOffice dan sebutkan namanya dalam permintaan Anda.
- Dokumen yang Anda buka selama sesi dapat diedit mulai pesan Anda berikutnya.

## Privasi dan pemakaian

- Bagian yang Anda sembunyikan dari AI tetap tersembunyi hanya jika aplikasi yang membacakan dokumen yang terbuka di GenOffice untuk agen. File yang dibaca agen sendiri dari folder dikirim apa adanya.
- Kata kunci pencarian web dan alamat halaman yang dibaca dikirim ke perusahaan pembuat program itu dan ke situs-situs tersebut. Jika akses internet untuk perintah Codex aktif, data dapat terkirim ke mana pun perintah terhubung.
- Agen bekerja dalam banyak langkah, jadi memakai lebih banyak kuota langganan Anda dibandingkan panel AI. Jika kuota habis, permintaan gagal; agen tidak pernah beralih ke AI lain atau ke koneksi yang berbayar.

## Jika terjadi masalah

| Yang tertulis di jendela                       | Yang perlu dilakukan                             |
| ---------------------------------------------- | ------------------------------------------------ |
| **Tidak terhubung**                            | Masuk ke program itu di **Pengaturan ▸ AI**.     |
| **Folder ini tidak dapat dipakai**             | Pilih folder yang hanya berisi bahan kerja Anda. |
| **Codex tidak dapat membuka sandbox**          | Perbarui Windows, atau pilih Claude Code.        |
| **Kuota langganan Anda sudah habis**           | Kirim lagi setelah kuota dipulihkan.             |
| **Versi program terlalu lama untuk mode agen** | Perbarui program itu, lalu klik **Sesi baru**.   |
