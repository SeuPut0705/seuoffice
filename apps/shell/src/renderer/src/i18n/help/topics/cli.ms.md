# Baris arahan dan ejen

Setiap pemasangan meliputi satu perintah `ieumoffice` yang memandu enjin yang sama seperti yang digunakan oleh tetingkap — penghurai yang sama, penulis yang sama, penjana yang sama. Fail yang disimpan aplikasi dan fail yang ditulis oleh perintah itu ialah fail yang sama, dan semakan yang melepasi panel AI aplikasi juga melepasi perintah itu.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` menunjukkan keseluruhan permukaannya dalam satu skrin: setiap perintah dengan satu baris yang menerangkan fungsinya, kemudian pilihan global dan kod keluar.

## Mendapatkan perintah itu

Perintah itu disertakan di dalam aplikasi. Untuk memanggilnya dengan nama, jalankan `ieumoffice install-cli` sekali: pada Windows, ia menambah folder yang mengandungi perintah itu pada `PATH` pengguna anda, dan terminal yang anda buka selepas itu akan menemuinya. **Tetapan ▸ Integrasi** menunjukkan sama ada terminal anda sudah menemui perintah itu dan, jika belum, baris tepat yang perlu dijalankan.

Ejen penulisan kod tidak memerlukan langkah itu. Aplikasi merekodkan lokasi perintah itu dalam `~/.ieumoffice/launcher`, dan ejen menemuinya di situ.

## Perintah yang perlu diketahui

| Perintah          | Apa yang ia lakukan                                                                                                                                                                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Membuka dokumen dalam aplikasi; memulakan aplikasi jika ia belum berjalan.                                                                                                                                                                          |
| `selection`       | Apa yang dipilih pengguna dalam fail itu sekarang, semasa aplikasi berjalan — penunjuk kepada "yang ini" / "di sini". Mengembalikan julat blok, julat sel dalam lembar, elemen slaid atau satu halaman, mengikut penyunting tempat fail itu berada. |
| `convert`         | Menukar antara format menggunakan enjin aplikasi itu sendiri.                                                                                                                                                                                       |
| `create`          | Mencipta dokumen daripada kandungan berstruktur.                                                                                                                                                                                                    |
| `render`          | Satu PNG bagi setiap halaman, mengikut susun atur penjana.                                                                                                                                                                                          |
| `pdf`             | Membaca lapisan teks PDF halaman demi halaman, tanpa proses aplikasi.                                                                                                                                                                               |
| `read-url`        | Membaca teks halaman web daripada baris arahan — artikel, dokumen atau pautan dalam sesuatu kemahiran; mencetak teks dan meneruskan dengan `--offset`.                                                                                              |
| `info`            | Metadatan dan ringkasan struktur sesebuah dokumen.                                                                                                                                                                                                  |
| `search`          | Carian web atau imej: carian percuma secara lalai, atau penyedia carian yang kuncinya anda pilih dalam aplikasi.                                                                                                                                    |
| `image` / `media` | Menghasilkan imej, atau menghuraikan dan bertanya soalan tentang fail imej, video atau audio.                                                                                                                                                       |
| `merge`           | Mengisi ruang letak `{{key}}` dalam templat `.docx`, `.pptx` atau `.xlsx`.                                                                                                                                                                          |
| `capabilities`    | Melaporkan ciri AI (carian, penjanaan imej, analisis imej dan video) yang tersedia pada mesin ini, dan melalui laluan mana.                                                                                                                         |
| `guide`           | Rujukan op dan panduan reka bentuk, dijana daripada definisi yang sama seperti yang disahkan oleh pelaku — jadi ia tidak mungkin berbeza daripada apa yang diterima oleh `apply`. `--json` mengembalikannya bersama skema setiap op.                |
| `install-cli`     | Meletakkan `ieumoffice` pada `PATH`.                                                                                                                                                                                                                |
| `skill`           | Menyenaraikan ejen penulisan kod yang ditemui pada mesin ini, dan memasang atau mengemas kini kemahiran GenOffice di dalamnya.                                                                                                                      |
| `mcp`             | Menyediakan setiap perintah sebagai alat Model Context Protocol. Lihat **Menyambungkan ejen penulisan kod**.                                                                                                                                        |

## Penyuntingan: docs, sheets, slides

`ieumoffice docs`, `ieumoffice sheet` dan `ieumoffice slides` membaca dan menyunting melalui laluan tulis yang sama seperti yang digunakan oleh aplikasi, dan mereka berkongsi satu kosa kata: **op** ialah satu suntingan, dan **spec** ialah senarai op yang digunakan mengikut urutan.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` melaporkan apa yang akan dilakukan oleh satu kelompok tanpa menulis apa-apa, dan itulah cara termurah untuk menyemak sesuatu spec sebelum ia benar-benar digunakan. Panel AI dalam aplikasi berjalan tepat pada op yang sama ini, jadi apa sahaja yang boleh anda mintanya boleh juga anda tulis sebagai skrip.

## Perintah carian, imej dan media

`search`, `image` dan `media` menggunakan apa yang disediakan dalam aplikasi di bawah Tetapan ▸ AI ▸ Lanjutan:

- `search` sentiasa berfungsi. Ia menggunakan carian percuma secara lalai, atau penyedia carian yang kuncinya anda pilih.
- `image` memerlukan kunci penyedia imej. Dalam versi ini, langganan tidak menjana imej.
- `media` untuk gambar menggunakan penyedia berasaskan kunci apabila ada yang disediakan. Ia menggunakan langganan Claude atau Codex anda hanya apabila anda membenarkannya, dan kebenaran itu **dimatikan secara lalai**; [Menyambungkan ejen penulisan kod](help://mcp) menerangkan suis itu dan hadnya.
- `media` untuk video atau audio memerlukan penyedia berasaskan kunci yang menyokong video.

`ieumoffice capabilities --json` melaporkan semua ini tanpa memanggil mana-mana AI. `detail` di dalamnya mengandungi:

| Medan                                                                            | Apa yang dinyatakannya                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Bagi setiap ciri: `available`; `via`, siapa yang menjawab; `route`, salah satu daripada `free`, `key` atau `subscription`; `metered: true` bagi log masuk bayar ikut guna; dan, apabila ciri itu tidak tersedia, `message`, iaitu teks yang dijawab oleh perintah itu sendiri. |
| `media_analysis`                                                                 | Dikekalkan untuk skrip lama: sama seperti `image_analysis`, atau seperti `video_analysis` apabila hanya video yang berfungsi.                                                                                                                                                  |
| `automatic_calls`                                                                | `subscription_enabled`, dan selagi ia dihidupkan, `used`, iaitu bilangan permintaan automatik yang dikendalikan dalam sejam yang lalu (untuk makluman sahaja); `limit` dan `remaining` sentiasa `null`.                                                                        |
| `app`                                                                            | `available`: sama ada aplikasi dipasang di tempat yang membolehkan perintah itu memulakannya.                                                                                                                                                                                  |
| `settings_path`                                                                  | Fail tetapan yang menjadi sumber jawapan ini.                                                                                                                                                                                                                                  |

Apabila `image` atau `media` tidak dapat dijalankan, perintah itu keluar dengan kod 4 dan `error: "app_unavailable"`, dan `detail.errorCode` menyatakan sebabnya. `unavailable` bermaksud tiada apa-apa yang disediakan untuk ciri itu, jadi mencuba lagi tidak akan membantu. `rate-limit` disertai `detail.resetsAt`, iaitu masa (dalam milisaat) apabila permintaan boleh dibuat semula.

## Apa yang disimpannya pada PC ini

Kedua-dua fail berada dalam folder `.ieumoffice` di dalam folder pengguna anda:

- `~/.ieumoffice/launcher` merekodkan lokasi perintah aplikasi, supaya ejen penulisan kod menemuinya walaupun ia tiada pada `PATH` anda.
- `~/.ieumoffice/cli-audit.jsonl` menerima satu baris bagi setiap perintah yang dijalankan — perintah itu, argumennya dan hasilnya — supaya anda boleh melihat kemudian apa yang dilakukan oleh ejen.

## Model Context Protocol

`ieumoffice mcp` menyediakan setiap perintah sebagai alat MCP, dan `ieumoffice mcp install <agent|all>` mendaftarkannya dalam konfigurasi sendiri ejen penulisan kod. Lihat **Menyambungkan ejen penulisan kod** untuk butiran lanjut.

## Apa yang tidak dilakukan oleh perintah itu

Ia membaca dan menulis fail. Ia bukan aplikasi: tiada tetingkap, dan dialog kemas kini dalam aplikasi tidak terpakai. Apa-apa yang memerlukan tiningkap — panel AI, langkah kawalan kualiti ke atas slaid yang telah dipaparkan — mesti menunggu sehingga anda membuka fail itu. `ieumoffice render` memberi anda piksel tanpa itu, dan `ieumoffice slides` mengaudit susun atur sesebuah dek secara sendiri.
