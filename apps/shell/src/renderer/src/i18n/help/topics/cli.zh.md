# 命令行与代理

每个安装版本都带一个 `ieumoffice` 命令，它驱动的是窗口所用的同一套引擎——同样的解析器、同样的写入器、同样的渲染器。应用保存的文件和命令写出的文件是同一个文件；应用 AI 面板能通过的检查，命令也能通过。

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` 一屏就能看全整个界面：每个命令后面都有一行说明它是做什么的，然后是全局选项和退出码。

## 取得命令

命令随应用一起提供。想直接按名字调用，先运行一次 `ieumoffice install-cli`：在 Windows 上，它会把命令所在的文件夹加进你的用户 `PATH`，之后打开的终端就能找到它。**设置 ▸ 集成**会显示你的终端是否已经能找到这个命令；如果找不到，还会给出需要运行的那一行命令。

编程代理不需要这一步。应用会把命令所在的位置记录在 `~/.ieumoffice/launcher` 里，它们从那里找到命令。

## 值得记住的命令

| 命令              | 作用                                                                                                                                   |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | 在应用里打开文档；应用没在运行时会先启动。                                                                                             |
| `selection`       | 应用正在运行时，用户此刻在该文件里选中的内容——也就是“这个”“这里”的指针。按文件所在的编辑器，返回块范围、工作表范围、幻灯片元素或页面。 |
| `convert`         | 用应用自己的引擎在格式之间转换。                                                                                                       |
| `create`          | 从结构化内容创建文档。                                                                                                                 |
| `render`          | 每页一张 PNG，按渲染器排出的版式输出。                                                                                                 |
| `pdf`             | 逐页读取 PDF 的文字层，不需要启动应用进程。                                                                                            |
| `read-url`        | 在命令行读取网页的正文——文章、文档或技能里的链接；输出文本，并用 `--offset` 接着读。                                                   |
| `info`            | 文档的元数据与结构摘要。                                                                                                               |
| `search`          | 网页或图片搜索：默认用免费搜索，或者用你在应用里选中的、填了密钥的搜索服务商。                                                         |
| `image` / `media` | 生成图片，或描述图片、视频、音频文件并向它们提问。                                                                                     |
| `merge`           | 填充 `.docx`、`.pptx` 或 `.xlsx` 模板里的 `{{key}}` 占位符。                                                                           |
| `capabilities`    | 报告本机可以使用哪些 AI 功能（搜索、生图、图片解析和视频解析），以及各自走哪条途径。                                                   |
| `guide`           | 操作参考与设计指南，由执行器校验所依据的同一份定义生成，因此不会与 `apply` 接受的内容产生偏差。`--json` 会带上每个操作的 schema 返回。 |
| `install-cli`     | 把 `ieumoffice` 放进 `PATH`。                                                                                                          |
| `skill`           | 列出本机找到的编程代理，并在其中安装或更新 GenOffice 技能。                                                                            |
| `mcp`             | 把每条命令作为 Model Context Protocol 工具提供。见**连接编程代理**。                                                                   |

## 编辑：docs、sheets、slides

`ieumoffice docs`、`ieumoffice sheet` 和 `ieumoffice slides` 都要先接一个子命令——`read`、`apply`、`check`，slides 另有 `audit`、`render`、`replace`——然后通过应用所用的同一条写入路径读写。它们共享一套词汇：一个 **op** 就是一次编辑，一个 **spec** 就是按顺序应用的一组 op。

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` 只报告一批操作会做什么，不写入任何内容，这是让一份 spec 落地前先自查最省事的办法。应用里的 AI 面板跑的就是这些 op，所以凡是你能让它做的事，都能写成脚本。

## 搜索、图片与媒体命令

`search`、`image` 和 `media` 用的是应用里 设置 ▸ AI ▸ 高级 下配置好的内容：

- `search` 始终可用。默认用免费搜索，或者用你选中的、填了密钥的搜索服务商。
- `image` 需要生图服务商的密钥。在这个版本里，订阅不能生成图片。
- `media` 处理图片时，如果配置了密钥服务商就用它。只有在你允许的情况下才会使用你的 Claude 或 Codex 订阅，而这一项**默认关闭**；这个开关及其限制见[连接编程助手](help://mcp)。
- `media` 处理视频或音频时，需要支持视频的密钥服务商。

`ieumoffice capabilities --json` 不调用任何 AI 就能报告以上全部情况。它的 `detail` 里有：

| 字段                                                                             | 含义                                                                                                                                                                                           |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`、`image_search`、`image_generation`、`image_analysis`、`video_analysis` | 每项功能各有：`available`；`via`，由谁来回答；`route`，取值为 `free`、`key` 或 `subscription` 之一；按量付费的登录会带 `metered: true`；功能不可用时还有 `message`，即命令自己给出的回答文字。 |
| `media_analysis`                                                                 | 为旧脚本保留：与 `image_analysis` 相同；只有视频可用时与 `video_analysis` 相同。                                                                                                               |
| `automatic_calls`                                                                | `subscription_enabled`；开启期间还有 `used`，即最近一小时处理的自动调用次数（仅供参考），`limit` 和 `remaining` 始终为 `null`。                                                                |
| `app`                                                                            | `available`：应用是否安装在命令能够启动它的位置。                                                                                                                                              |
| `settings_path`                                                                  | 这些回答所读取的设置文件。                                                                                                                                                                     |

`image` 或 `media` 无法运行时，命令以退出码 4 和 `error: "app_unavailable"` 结束，`detail.errorCode` 说明原因。`unavailable` 表示这项功能什么都没有配置，重试也没用。`rate-limit` 会带上 `detail.resetsAt`，即可以再次请求的时间（单位为毫秒）。

## 它在这台电脑上保存什么

两个文件都在你用户文件夹下的 `.ieumoffice` 文件夹里：

- `~/.ieumoffice/launcher` 记录应用的命令在哪里，这样即使命令不在你的 `PATH` 上，编程代理也能找到它。
- `~/.ieumoffice/cli-audit.jsonl` 会为每一条运行过的命令记一行——命令、参数和结果——方便你事后查看代理做了什么。

## Model Context Protocol

`ieumoffice mcp` 把每条命令作为 MCP 工具提供；`ieumoffice mcp install <agent|all>` 则把它注册到编程代理自己的配置里。这一侧见**连接编程代理**。

## 命令不会做的事

它只负责读写文件。它不是应用：没有窗口，应用内的更新对话框也不适用。凡是需要窗口的事——AI 面板、对渲染后幻灯片的 QC 检查——都得等你打开文件。`ieumoffice render` 可以在没有窗口的情况下拿到像素，`ieumoffice slides` 也能自己检查一份演示文稿的版面。
