# Baris perintah dan agen

Setiap pemasangan membawa perintah `ieumoffice` yang menjalankan mesin yang sama dengan jendela — parser yang sama, penulis yang sama, perender yang sama. Berkas yang disimpan aplikasi dan berkas yang ditulis perintah itu adalah berkas yang sama, dan pemeriksaan yang lolos di panel AI aplikasi juga lolos di perintah.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` menampilkan seluruh permukaannya dalam satu layar: setiap perintah dengan satu baris yang menjelaskan apa yang dilakukannya, lalu opsi global dan kode keluar.

## Mendapatkan perintahnya

Perintah ini disertakan di dalam aplikasi. Untuk memanggilnya dengan nama, jalankan sekali `ieumoffice install-cli`: di Windows, perintah itu menambahkan folder tempat perintah berada ke `PATH` pengguna Anda, dan terminal yang Anda buka setelahnya akan menemukannya. **Pengaturan ▸ Integrasi** menunjukkan apakah terminal Anda sudah menemukan perintah itu dan, jika belum, baris persis yang harus dijalankan.

Agen pemrograman tidak memerlukan langkah itu. Aplikasi mencatat letak perintah di `~/.ieumoffice/launcher`, dan agen menemukannya di sana.

## Perintah yang perlu diketahui

| Perintah          | Yang dikerjakan                                                                                                                                                                                                                                          |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Membuka dokumen di aplikasi; memulai aplikasi bila belum berjalan.                                                                                                                                                                                       |
| `selection`       | Apa yang dipilih pengguna di berkas itu sekarang juga, selagi aplikasi berjalan — penunjuk untuk "yang ini" / "di sini". Mengembalikan rentang blok, rentang sel di lembar, elemen slide, atau satu halaman, tergantung editor tempat berkas itu berada. |
| `convert`         | Mengonversi antarformat memakai mesin milik aplikasi itu sendiri.                                                                                                                                                                                        |
| `create`          | Membuat dokumen dari konten terstruktur.                                                                                                                                                                                                                 |
| `render`          | Satu PNG per halaman, sebagaimana diletakkan oleh perender.                                                                                                                                                                                              |
| `pdf`             | Membaca lapisan teks PDF halaman demi halaman, tanpa proses aplikasi.                                                                                                                                                                                    |
| `read-url`        | Membaca teks halaman web dari baris perintah — artikel, dokumen, atau tautan di sebuah skill; mencetak teks dan melanjutkan dengan `--offset`.                                                                                                           |
| `info`            | Metadata dan ringkasan struktur sebuah dokumen.                                                                                                                                                                                                          |
| `search`          | Pencarian web atau gambar: pencarian gratis secara bawaan, atau penyedia pencarian yang kuncinya Anda pilih di aplikasi.                                                                                                                                 |
| `image` / `media` | Menghasilkan gambar, atau mendeskripsikan dan mengajukan pertanyaan tentang berkas gambar, video, atau audio.                                                                                                                                            |
| `merge`           | Mengisi placeholder `{{key}}` pada templat `.docx`, `.pptx`, atau `.xlsx`.                                                                                                                                                                               |
| `capabilities`    | Melaporkan fitur AI mana (pencarian, pembuatan gambar, analisis gambar dan video) yang tersedia di komputer ini, dan lewat jalur apa.                                                                                                                    |
| `guide`           | Referensi op dan panduan desain, dibangkitkan dari definisi yang sama dengan yang dipakai eksekutor untuk memvalidasi — jadi tidak mungkin melenceng dari apa yang diterima `apply`. `--json` mengembalikannya beserta skema tiap op.                    |
| `install-cli`     | Menaruh `ieumoffice` di `PATH`.                                                                                                                                                                                                                          |
| `skill`           | Mendaftarkan agen pemrograman yang ditemukan di komputer ini, lalu memasang atau memperbarui skill GenOffice di dalamnya.                                                                                                                                |
| `mcp`             | Menyajikan semua perintah sebagai alat Model Context Protocol. Lihat **Menghubungkan agen pemrograman**.                                                                                                                                                 |

## Menyunting: dokumen, lembar, presentasi

`ieumoffice docs`, `ieumoffice sheet`, dan `ieumoffice slides` membaca dan menulis lewat jalur tulis yang sama dengan yang dipakai aplikasi, dan mereka berbagi satu kosakata: sebuah **op** adalah satu suntingan, dan sebuah **spec** adalah daftar op yang diterapkan berurutan.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` melaporkan apa yang akan dilakukan sebuah batch tanpa menulis apa pun, dan itulah cara murah untuk memeriksa sebuah spec sebelum dijalankan. Panel AI di aplikasi berjalan persis pada op-op ini, jadi apa pun yang bisa Anda minta kepadanya bisa Anda skripkan.

## Perintah pencarian, gambar, dan media

`search`, `image`, dan `media` memakai apa yang disiapkan di aplikasi pada Pengaturan ▸ AI ▸ Lanjutan:

- `search` selalu berfungsi. Perintah ini memakai pencarian gratis secara bawaan, atau penyedia pencarian yang kuncinya Anda pilih.
- `image` memerlukan kunci penyedia gambar. Pada versi ini langganan tidak membuat gambar.
- `media` untuk gambar memakai penyedia berbasis kunci bila ada yang disiapkan. Perintah ini memakai langganan Claude atau Codex Anda hanya jika Anda sudah mengizinkannya, dan itu **nonaktif secara bawaan**; [Menghubungkan agen coding](help://mcp) menjelaskan sakelar itu beserta batasannya.
- `media` untuk video atau audio memerlukan penyedia berbasis kunci yang mendukung video.

`ieumoffice capabilities --json` melaporkan semua ini tanpa memanggil AI apa pun. `detail`-nya berisi:

| Bidang                                                                           | Isinya                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Untuk setiap fitur: `available`; `via`, siapa yang menjawab; `route`, salah satu dari `free`, `key`, atau `subscription`; `metered: true` untuk login bayar sesuai pemakaian; dan, bila fiturnya tidak tersedia, `message`, yaitu teks yang dipakai perintah itu sendiri untuk menjawab. |
| `media_analysis`                                                                 | Dipertahankan untuk skrip lama: sama dengan `image_analysis`, atau dengan `video_analysis` bila hanya video yang berfungsi.                                                                                                                                                              |
| `automatic_calls`                                                                | `subscription_enabled`, dan selama itu aktif, `used`, yaitu jumlah permintaan otomatis yang ditangani dalam satu jam terakhir (hanya sebagai informasi); `limit` dan `remaining` selalu `null`.                                                                                          |
| `app`                                                                            | `available`: apakah aplikasi terpasang di tempat yang bisa dijalankan oleh perintah.                                                                                                                                                                                                     |
| `settings_path`                                                                  | Berkas pengaturan yang menjadi sumber jawaban-jawaban ini.                                                                                                                                                                                                                               |

Ketika `image` atau `media` tidak dapat berjalan, perintah keluar dengan kode 4 dan `error: "app_unavailable"`, dan `detail.errorCode` menyebutkan alasannya. `unavailable` berarti tidak ada yang disiapkan untuk fitur itu, jadi mencoba lagi tidak akan membantu. `rate-limit` disertai `detail.resetsAt`, yaitu waktu (dalam milidetik) ketika permintaan bisa dilakukan lagi.

## Apa yang disimpannya di PC ini

Kedua berkas berada di folder `.ieumoffice` di dalam folder pengguna Anda:

- `~/.ieumoffice/launcher` mencatat letak perintah aplikasi, sehingga agen pemrograman menemukannya meskipun perintah itu tidak ada di `PATH` Anda.
- `~/.ieumoffice/cli-audit.jsonl` mendapat satu baris untuk setiap perintah yang dijalankan — perintahnya, argumennya, dan hasilnya — sehingga Anda bisa melihat belakangan apa yang dilakukan sebuah agen.

## Model Context Protocol

`ieumoffice mcp` menyajikan setiap perintah sebagai alat MCP, dan `ieumoffice mcp install <agent|all>` mendaftarkannya di konfigurasi milik agen pemrograman itu sendiri. Lihat **Menghubungkan agen pemrograman** untuk sisi tersebut.

## Yang tidak dilakukan perintah

Perintah itu membaca dan menulis berkas. Ia bukan aplikasinya: tidak ada jendela, dan dialog pembaruan di dalam aplikasi tidak berlaku. Apa pun yang membutuhkan jendela — panel AI, pemeriksaan mutu atas satu slide hasil render — harus menunggu Anda membuka berkasnya. `ieumoffice render` memberi Anda pikselnya tanpa jendela, dan `ieumoffice slides` menata letak sebuah deck secara mandiri.
