# Mod ejen

Ejen menjadikan satu folder yang anda pilih sebagai projek dan menjalankan Claude Code atau Codex daripada PC ini dalam folder itu. AI membaca sendiri bahan dalam folder, mencipta fail baharu, menggunakan kemahiran dan skrip, serta menyunting dokumen yang dibuka dalam GenOffice. Gunakannya untuk kerja yang memerlukan banyak bahan.

## Sebelum bermula

- Program Claude Code atau Codex yang disambungkan di bawah **Tetapan ▸ AI** (dilog masuk dengan langganan Claude atau pelan ChatGPT). ChatGPT yang disambungkan terus dalam aplikasi tidak digunakan oleh ejen. Topik "Sambungan langganan" menerangkan caranya.
- Folder yang mengandungi bahan anda. Keseluruhan pemacu, keseluruhan folder rumah anda, dan folder data log masuk atau data aplikasi tidak boleh dipilih.

## Memulakan sesi

1. Di bar sisi kiri Laman Utama, tekan **Ejen**. Tetingkap ejen dibuka secara berasingan.
2. Tekan **Pilih folder…** untuk memilih folder projek. Folder yang anda gunakan baru-baru ini disenaraikan di bawah **Folder terkini**.
3. Di bawah **Program**, pilih Claude Code atau Codex. Program yang tidak bersambung tidak boleh dipilih.
4. Di bawah **Bila hendak bertanya kepada anda**, pilih cara ejen meminta kebenaran (lihat jadual di bawah).
5. Pada kali pertama, baca **Sebelum anda mula** dan tekan **Saya faham**.
6. Tekan **Mula**, tulis apa yang anda mahu dilakukan, dan tekan **Hantar**.

Satu tetingkap ialah satu sesi. Menutup tetingkap atau menekan **Henti** menamatkan sesi, dan program yang dimulakan oleh GenOffice untuk sesi itu turut ditamatkan. Sesi juga tamat selepas 30 minit tanpa apa-apa dihantar.

## Cara ejen bertanya

| Pilihan                                          | Terus dilakukan                                                              | Ditanya dahulu                                                      |
| ------------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **Tanya sebelum setiap arahan** (lalai)          | Membaca dan menulis fail dalam folder projek, menyunting dokumen yang dibuka | Menjalankan arahan atau skrip, membaca di luar folder projek        |
| **Tanya sebelum menulis dan menjalankan arahan** | Membaca fail dalam folder projek, menyunting dokumen yang dibuka             | Menulis fail, menjalankan arahan atau skrip, membaca di luar folder |
| **Percayai projek ini**                          | Hampir semua perkara                                                         | Membaca di luar folder projek                                       |

Apabila ejen bertanya, tetingkap menunjukkan apa yang hendak dilakukannya (arahan penuh, laluan fail). Tekan **Benarkan** atau **Tolak**.

Apa jua pilihan anda, ejen tidak akan:

- Menulis ganti fail dokumen yang dibuka dalam tab GenOffice. Dokumen yang dibuka disunting melalui aplikasi, jadi perubahan terus kelihatan dalam editor dan fungsi buat asal editor boleh membatalkannya.
- Menulis di luar folder projek.
- Menyentuh data log masuk Claude atau Codex, atau folder data GenOffice.

## Claude Code dan Codex

- **Codex** menjalankan arahan dalam ruang terasingnya sendiri, termasuk arahan yang anda benarkan. Ia hanya boleh menulis dalam folder projek, internet disekat melainkan anda menghidupkannya, dan ia tidak boleh membaca fail peribadi anda di luar projek. Apabila sesi bermula, GenOffice terlebih dahulu menyemak sama ada pengasingan ini berfungsi pada PC ini, dan tidak memulakan sesi jika tidak.
- **Claude Code** tidak dapat mengasingkan arahan pada Windows. Arahan yang anda benarkan boleh mencapai seluruh PC dan internet. Sebab itulah, dalam **Percayai projek ini**, penyemak Claude Code sendiri yang memeriksa setiap tindakan bagi pihak anda.

Dokumen yang dihantar oleh orang lain mungkin mengandungi arahan tersembunyi yang menyuruh AI melakukan perkara lain. Dalam folder yang berisi bahan yang anda tidak kenali, gunakan salah satu pilihan yang bertanya dahulu.

## Carian web dan internet

- **Claude Code** boleh mencari di web dan membaca halaman web, tetapi bertanya dahulu. Ia bertanya kali pertama ia mencari, dan bagi setiap laman yang halamannya hendak dibaca. Dalam soalan itu, **Benarkan carian sepanjang sesi ini** atau **Benarkan laman ini sepanjang sesi ini** menghentikannya daripada bertanya lagi sehingga sesi tamat. Dalam **Percayai projek ini**, penyemak Claude Code sendiri yang membuat keputusan.
- Apabila anda memilih **Codex**, skrin mula memaparkan dua lagi tetapan.

| Tetapan                         | Pilihan                           | Pada mulanya    |
| ------------------------------- | --------------------------------- | --------------- |
| **Carian web**                  | Hasil tersimpan / Langsung / Mati | Hasil tersimpan |
| **Akses internet untuk arahan** | Mati / Hidup                      | Mati            |

- Hasil tersimpan datang daripada kandungan web yang dikumpul lebih awal; Langsung mencari web seperti keadaannya sekarang.
- Kedua-dua tetapan diingat bagi setiap folder projek. Folder yang digunakan buat kali pertama bermula dengan nilai di atas.
- Apabila akses internet untuk arahan dihidupkan, arahan yang dijalankan oleh Codex boleh mencapai internet. Dalam **Percayai projek ini**, arahan mencapainya tanpa bertanya, dan arahan tersembunyi dalam dokumen yang anda terima boleh menyebabkan data anda dihantar keluar. Amaran ini dipaparkan apabila anda menghidupkannya. Hidupkan hanya apabila perlu. Kemahiran terbina dalam "Cari kemahiran" hanya berfungsi apabila tetapan ini hidup.

## Nota projek dan kemahiran

- Jika folder itu mempunyai `CLAUDE.md` atau `AGENTS.md`, kandungannya diberikan kepada ejen sebagai arahan. Tuliskan perkara yang perlu dipatuhi setiap kali: nada, istilah, format dokumen yang hendak dihasilkan.
- Tetingkap ejen menggunakan kemahiran yang dihidupkan dalam **Tetapan ▸ Kemahiran**. Claude Code dan Codex mendapat senarai yang sama. Maklumat lanjut tentang kemahiran ada dalam [Kemahiran](help://skills).
- Kemahiran dalam `.claude/skills` dan `.agents/skills` folder projek digunakan dalam sesi itu tanpa perlu dihidupkan.
- Pilih kemahiran dengan `/` atau `$` dalam kotak input, dan arahan supaya membaca serta mengikut kemahiran itu diletakkan di hadapan permintaan anda.
- Senarai kemahiran ditetapkan apabila sesi bermula. Jika anda menghidupkan atau mematikan kemahiran semasa sesi, "Kemahiran yang diubah berkuat kuasa mulai sesi seterusnya" dipaparkan.
- Apabila ejen membuat kemahiran, kad kemahiran muncul dalam tetingkap; apabila ia menemui kemahiran yang wajar dipasang, pratonton pemasangan muncul. Tiada apa-apa disimpan atau dipasang sehingga anda mengklik **Simpan** atau **Pasang**, dan kemahiran yang dipasang tersedia mulai sesi seterusnya.
- Program yang digunakan oleh skrip sesuatu kemahiran (Python dan sebagainya) mesti dipasang pada PC ini.
- Jika anda pernah menggunakan ejen dalam versi terdahulu, kali pertama anda membuka tetingkap ejen, satu notis sekali sahaja memaparkan: "Kemahiran kini dihidupkan dan dimatikan dalam Tetapan → Kemahiran. Kemahiran dalam folder kemahiran Claude dan Codex bermula dalam keadaan mati." **Buka Tetapan** membawa anda terus ke sana.

## Fail baharu dan dokumen yang dibuka

- Fail baharu yang dibuat oleh ejen disimpan dalam folder projek. Tekan **Buka** pada baris itu dalam log kemajuan untuk membuka fail tersebut dalam tab GenOffice.
- Untuk meminta dokumen yang dibuka disunting, buka dokumen itu dalam GenOffice dahulu dan sebut namanya dalam permintaan anda.
- Dokumen yang anda buka semasa sesi boleh disunting mulai mesej anda yang seterusnya.

## Privasi dan penggunaan

- Bahagian yang anda sembunyikan daripada AI hanya kekal tersembunyi apabila aplikasi membaca dokumen yang dibuka dalam GenOffice untuk ejen. Fail yang dibaca sendiri oleh ejen dari folder dihantar seadanya.
- Istilah carian web dan alamat halaman yang dibaca dihantar kepada syarikat program itu dan kepada laman-laman tersebut. Apabila akses internet untuk arahan Codex dihidupkan, data boleh dihantar ke mana-mana sahaja arahan bersambung.
- Ejen bekerja dalam banyak langkah, jadi ia menggunakan lebih banyak had langganan anda berbanding panel AI. Apabila had habis, permintaan itu gagal; ejen tidak pernah beralih kepada AI lain atau kepada sambungan yang dikenakan bayaran.

## Jika ada masalah

| Apa yang tertera pada tetingkap           | Apa yang perlu dibuat                                   |
| ----------------------------------------- | ------------------------------------------------------- |
| **Tidak bersambung**                      | Log masuk ke program itu di bawah **Tetapan ▸ AI**.     |
| **Folder ini tidak boleh digunakan**      | Pilih folder yang hanya mengandungi bahan kerja anda.   |
| **Codex tidak dapat membuka kotak pasir** | Kemas kini Windows, atau pilih Claude Code.             |
| **Had langganan anda telah habis**        | Hantar semula selepas had ditetapkan semula.            |
| **Program terlalu lama untuk mod ejen**   | Kemas kini program itu, kemudian tekan **Sesi baharu**. |
