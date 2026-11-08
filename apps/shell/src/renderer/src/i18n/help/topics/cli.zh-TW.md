# 命令列與代理

每次安裝都會附帶一個 `ieumoffice` 命令，它驅動的是視窗所用的同一套引擎——同樣的解析器、同樣的寫入器、同樣的算繪器。應用程式儲存的檔案與命令寫出的檔案是同一個檔案；應用程式 AI 面板能通過的檢查，命令也能通過。

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` 在一個畫面裡就列出了整個介面：每個命令後面都有一行說明它是做什麼的，然後是全域選項和結束碼。

## 取得命令

這個命令是隨應用程式一起提供的。想直接按名稱呼叫，先執行一次 `ieumoffice install-cli`：在 Windows 上，它會把命令所在的資料夾加進你的使用者 `PATH`，之後開啟的終端機就找得到它。**設定 ▸ 整合**會顯示你的終端機是否已經找得到這個命令；如果找不到，還會列出該執行的那一行指令。

程式開發代理不需要這個步驟。應用程式會把命令的位置記錄在 `~/.ieumoffice/launcher`，它們會從那裡找到命令。

## 值得記住的命令

| 命令              | 用途                                                                                                                                           |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | 在應用程式裡開啟文件；應用程式沒有執行時會先啟動。                                                                                             |
| `selection`       | 應用程式執行時，使用者此刻在該檔案中選取的內容——也就是「這個」「這裡」的指標。依檔案所在的編輯器，回傳區塊範圍、儲存格範圍、投影片元素或頁面。 |
| `convert`         | 用應用程式自己的引擎在格式之間轉換。                                                                                                           |
| `create`          | 從結構化內容建立文件。                                                                                                                         |
| `render`          | 每頁一張 PNG，依算繪器排出的版面輸出。                                                                                                         |
| `pdf`             | 逐頁讀取 PDF 的文字層，不需要啟動應用程式行程。                                                                                                |
| `read-url`        | 在命令列讀取網頁的正文——文章、文件或技能裡的連結；輸出文字，並用 `--offset` 接著讀。                                                           |
| `info`            | 文件的中繼資料與結構摘要。                                                                                                                     |
| `search`          | 網頁或圖片搜尋：預設使用免費搜尋，或是使用你在應用程式裡選用、已填入金鑰的搜尋服務商。                                                         |
| `image` / `media` | 產生圖片，或描述圖片、影片、音訊檔案並向它們提問。                                                                                             |
| `merge`           | 填入 `.docx`、`.pptx` 或 `.xlsx` 範本中的 `{{key}}` 預留位置。                                                                                 |
| `capabilities`    | 回報本機可以使用哪些 AI 功能（搜尋、生圖、圖片解析與影片解析），以及各自走哪一條途徑。                                                         |
| `guide`           | 操作參考與設計指南，由執行器驗證所依據的同一份定義產生，因此不會與 `apply` 接受的內容產生落差。`--json` 會連同每個操作的 schema 一起回傳。     |
| `install-cli`     | 把 `ieumoffice` 放進 `PATH`。                                                                                                                  |
| `skill`           | 列出本機找到的程式開發代理，並在其中安裝或更新 GenOffice 技能。                                                                                |
| `mcp`             | 把每個命令當成 Model Context Protocol 工具提供。見**連接程式開發代理**。                                                                       |

## 編輯：docs、sheets、slides

`ieumoffice docs`、`ieumoffice sheet` 與 `ieumoffice slides` 都要先接一個子命令——`read`、`apply`、`check`，slides 另有 `audit`、`render`、`replace`——再透過應用程式所用的同一條寫入路徑讀寫。它們共用一套詞彙：一個 **op** 就是一次編輯，一個 **spec** 就是依序套用的一組 op。

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` 只會回報一批操作會做什麼，不寫入任何內容，這是讓一份 spec 落地前先自查最省事的辦法。應用程式裡的 AI 面板跑的就是這些 op，所以凡是你能請它做的事，都能寫成指令碼。

## 搜尋、圖片與媒體命令

`search`、`image` 與 `media` 用的是應用程式裡 設定 ▸ AI ▸ 進階 底下設定好的內容：

- `search` 一律可用。預設使用免費搜尋，或是使用你選用、已填入金鑰的搜尋服務商。
- `image` 需要生圖服務商的金鑰。在這個版本裡，訂閱無法產生圖片。
- `media` 處理圖片時，如果已設定金鑰服務商就會用它。只有在你允許的情況下才會使用你的 Claude 或 Codex 訂閱，而這一項**預設關閉**；這個開關和它的限制請見[連接程式設計助手](help://mcp)。
- `media` 處理影片或音訊時，需要支援影片的金鑰服務商。

`ieumoffice capabilities --json` 不必呼叫任何 AI 就能回報以上所有情況。它的 `detail` 裡有：

| 欄位                                                                             | 內容                                                                                                                                                                                                 |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`、`image_search`、`image_generation`、`image_analysis`、`video_analysis` | 每項功能各有：`available`；`via`，由誰回答；`route`，值為 `free`、`key` 或 `subscription` 其中之一；依用量付費的登入會帶有 `metered: true`；功能無法使用時還有 `message`，也就是命令本身回覆的文字。 |
| `media_analysis`                                                                 | 為舊的指令碼保留：與 `image_analysis` 相同；只有影片可用時則與 `video_analysis` 相同。                                                                                                               |
| `automatic_calls`                                                                | `subscription_enabled`；開啟期間還有 `used`，即最近一小時處理的自動呼叫次數（僅供參考），`limit` 與 `remaining` 一律為 `null`。                                                                      |
| `app`                                                                            | `available`：應用程式是否安裝在命令能夠啟動它的位置。                                                                                                                                                |
| `settings_path`                                                                  | 這些回覆所讀取的設定檔。                                                                                                                                                                             |

`image` 或 `media` 無法執行時，命令會以結束碼 4 和 `error: "app_unavailable"` 結束，`detail.errorCode` 會說明原因。`unavailable` 表示這項功能完全沒有設定，所以重試也沒有用。`rate-limit` 會附上 `detail.resetsAt`，也就是可以再次提出要求的時間（單位為毫秒）。

## 它在這台電腦上保存什麼

兩個檔案都在你使用者資料夾底下的 `.ieumoffice` 資料夾裡：

- `~/.ieumoffice/launcher` 記錄應用程式的命令在哪裡，這樣即使命令不在你的 `PATH` 上，程式開發代理也找得到它。
- `~/.ieumoffice/cli-audit.jsonl` 會為每一個執行過的命令寫入一行——命令、引數與結果——方便你事後查看代理做了什麼。

## Model Context Protocol

`ieumoffice mcp` 把每個命令當成 MCP 工具提供；`ieumoffice mcp install <agent|all>` 則會把它註冊到程式開發代理自己的設定裡。這一側見**連接程式開發代理**。

## 命令不會做的事

它只負責讀寫檔案。它不是應用程式：沒有視窗，應用程式內的更新對話方塊也不適用。凡是需要視窗的事——AI 面板、對算繪後投影片的 QC 檢查——都得等你開啟檔案。`ieumoffice render` 可以在沒有視窗的情況下取得像素，`ieumoffice slides` 也能自行稽核一份簡報的版面。
