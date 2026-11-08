# Dòng lệnh và tác nhân

Mọi bản cài đặt đều kèm lệnh `ieumoffice` điều khiển đúng những engine mà cửa sổ dùng — cùng bộ phân tích, cùng bộ ghi, cùng bộ kết xuất. Một tệp do ứng dụng lưu và một tệp do lệnh ghi là cùng một tệp, và một kiểm tra mà bảng AI của ứng dụng vượt qua thì lệnh cũng vượt qua.

```sh
ieumoffice --help          # every command
ieumoffice guide slides    # the op reference, for writing your own
```

`ieumoffice --help` là toàn bộ bề mặt trong một màn hình: mọi lệnh đều có một dòng giải thích nó làm gì, rồi đến các tùy chọn toàn cục và mã thoát.

## Lấy lệnh

Lệnh này đi kèm ngay trong ứng dụng. Để gọi bằng tên, chạy một lần `ieumoffice install-cli`: trên Windows, nó thêm thư mục chứa lệnh vào `PATH` người dùng của bạn, và các terminal bạn mở sau đó sẽ tìm thấy lệnh. **Cài đặt ▸ Tích hợp** cho biết terminal của bạn đã tìm thấy lệnh hay chưa, và nếu chưa thì hiển thị đúng dòng cần chạy.

Các tác nhân lập trình không cần bước đó. Ứng dụng ghi lại vị trí của lệnh trong `~/.ieumoffice/launcher`, và chúng tìm lệnh ở đó.

## Những lệnh đáng biết

| Lệnh              | Tác dụng                                                                                                                                                                                                                                                               |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`            | Mở một tài liệu trong ứng dụng; khởi động ứng dụng nếu nó chưa chạy.                                                                                                                                                                                                   |
| `selection`       | Những gì người dùng đang chọn trong tệp đó ngay lúc này, khi ứng dụng còn chạy — đó là con trỏ cho "cái này" / "ở đây". Lệnh trả về một dải khối, một dải ô trong bảng tính, các phần tử trên một trang chiếu hoặc một trang, tùy theo trình chỉnh sửa đang mở tệp đó. |
| `convert`         | Chuyển đổi giữa các định dạng bằng chính engine của ứng dụng.                                                                                                                                                                                                          |
| `create`          | Tạo tài liệu từ nội dung có cấu trúc.                                                                                                                                                                                                                                  |
| `render`          | Một PNG cho mỗi trang, đúng bố cục do bộ kết xuất dàn ra.                                                                                                                                                                                                              |
| `pdf`             | Đọc lớp văn bản của PDF từng trang một, không cần tiến trình ứng dụng.                                                                                                                                                                                                 |
| `read-url`        | Đọc văn bản của một trang web từ dòng lệnh — bài viết, tài liệu hoặc liên kết trong một kỹ năng; in văn bản ra và đọc tiếp với `--offset`.                                                                                                                             |
| `info`            | Siêu dữ liệu và phần tóm tắt cấu trúc của tài liệu.                                                                                                                                                                                                                    |
| `search`          | Tìm kiếm web hoặc hình ảnh: mặc định dùng tìm kiếm miễn phí, hoặc dùng nhà cung cấp tìm kiếm mà bạn đã chọn khóa trong ứng dụng.                                                                                                                                       |
| `image` / `media` | Tạo hình ảnh, hoặc mô tả và đặt câu hỏi về một tệp hình ảnh, video hay âm thanh.                                                                                                                                                                                       |
| `merge`           | Điền các vùng chờ `{{key}}` trong một mẫu `.docx`, `.pptx` hoặc `.xlsx`.                                                                                                                                                                                               |
| `capabilities`    | Báo cáo những tính năng AI nào (tìm kiếm, tạo hình ảnh, phân tích hình ảnh và video) dùng được trên máy này, và qua đường nào.                                                                                                                                         |
| `guide`           | Tra cứu thao tác và các hướng dẫn thiết kế, sinh ra từ đúng những định nghĩa mà bộ thực thi dùng để kiểm tra — nên nó không thể lệch khỏi những gì `apply` chấp nhận. `--json` trả về tra cứu kèm lược đồ của từng thao tác.                                           |
| `install-cli`     | Đưa `ieumoffice` vào `PATH`.                                                                                                                                                                                                                                           |
| `skill`           | Liệt kê các tác nhân lập trình tìm thấy trên máy này rồi cài hoặc cập nhật kỹ năng GenOffice trong chúng.                                                                                                                                                              |
| `mcp`             | Phục vụ mọi lệnh như một công cụ của Model Context Protocol. Xem **Kết nối tác nhân lập trình**.                                                                                                                                                                       |

## Soạn thảo: tài liệu, bảng tính, bản trình chiếu

`ieumoffice docs`, `ieumoffice sheet` và `ieumoffice slides` đọc và sửa qua đúng lối ghi mà ứng dụng dùng, và chúng chia sẻ một từ vựng: một **thao tác** (op) là một lần sửa, còn một **đặc tả** (spec) là danh sách các thao tác áp dụng theo thứ tự.

```sh
ieumoffice sheet read report.xlsx
ieumoffice slides apply deck.pptx --ops ops.json --dry-run
ieumoffice docs apply brief.docx --ops ops.json
```

`--dry-run` cho biết một lô sẽ làm gì và không ghi gì cả, đây là cách rẻ nhất để kiểm tra một đặc tả trước khi nó áp dụng. Bảng AI trong ứng dụng chạy đúng trên những thao tác này, nên bất cứ điều gì bạn nhờ nó làm thì bạn cũng viết kịch bản được.

## Các lệnh tìm kiếm, hình ảnh và phương tiện

`search`, `image` và `media` dùng những gì đã được thiết lập trong ứng dụng ở Cài đặt ▸ AI ▸ Nâng cao:

- `search` lúc nào cũng dùng được. Mặc định nó dùng tìm kiếm miễn phí, hoặc dùng nhà cung cấp tìm kiếm mà bạn đã chọn khóa.
- `image` cần khóa của nhà cung cấp hình ảnh. Trong phiên bản này, gói đăng ký không tạo được hình ảnh.
- `media` với một hình ảnh sẽ dùng nhà cung cấp dùng khóa khi có một nhà cung cấp như vậy được thiết lập. Nó chỉ dùng gói đăng ký Claude hoặc Codex của bạn khi bạn đã cho phép, và việc đó **tắt mặc định**; [Kết nối tác nhân lập trình](help://mcp) giải thích công tắc này và các giới hạn của nó.
- `media` với video hoặc âm thanh cần một nhà cung cấp dùng khóa có hỗ trợ video.

`ieumoffice capabilities --json` báo cáo tất cả những điều này mà không gọi AI nào. Phần `detail` của nó chứa:

| Trường                                                                           | Ý nghĩa                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`, `image_search`, `image_generation`, `image_analysis`, `video_analysis` | Với mỗi tính năng: `available`; `via`, bên trả lời; `route`, một trong `free`, `key` hoặc `subscription`; `metered: true` nếu là đăng nhập tính phí theo mức sử dụng; và khi tính năng không dùng được, `message`, đoạn văn bản mà chính lệnh đó trả lời. |
| `media_analysis`                                                                 | Được giữ lại cho các kịch bản cũ: giống `image_analysis`, hoặc giống `video_analysis` khi chỉ video hoạt động.                                                                                                                                            |
| `automatic_calls`                                                                | `subscription_enabled`, và khi mục đó đang bật thì có thêm `used`, số yêu cầu tự động đã xử lý trong một giờ qua (chỉ để tham khảo); `limit` và `remaining` luôn là `null`.                                                                               |
| `app`                                                                            | `available`: ứng dụng có được cài ở nơi mà lệnh khởi động được nó hay không.                                                                                                                                                                              |
| `settings_path`                                                                  | Tệp cài đặt mà các câu trả lời này được đọc từ đó.                                                                                                                                                                                                        |

Khi `image` hoặc `media` không chạy được, lệnh thoát với mã 4 và `error: "app_unavailable"`, còn `detail.errorCode` cho biết lý do. `unavailable` nghĩa là chưa có gì được thiết lập cho tính năng đó, nên thử lại cũng không ích gì. `rate-limit` đi kèm `detail.resetsAt`, thời điểm (tính bằng mili giây) có thể gửi yêu cầu trở lại.

## Những gì lệnh lưu trên máy tính này

Cả hai tệp đều nằm trong thư mục `.ieumoffice` bên trong thư mục người dùng của bạn:

- `~/.ieumoffice/launcher` ghi lại vị trí lệnh của ứng dụng, để một tác nhân lập trình tìm thấy lệnh ngay cả khi lệnh không nằm trên `PATH` của bạn.
- `~/.ieumoffice/cli-audit.jsonl` nhận thêm một dòng cho mỗi lệnh đã chạy — lệnh, các đối số và kết quả — để sau đó bạn có thể xem một tác nhân đã làm gì.

## Model Context Protocol

`ieumoffice mcp` phục vụ mọi lệnh như một công cụ MCP, và `ieumoffice mcp install <agent|all>` đăng ký nó vào cấu hình riêng của một tác nhân lập trình. Xem **Kết nối tác nhân lập trình** cho phần bên kia.

## Điều lệnh không làm

Nó đọc tệp và ghi tệp. Nó không phải ứng dụng: không có cửa sổ, và hộp thoại cập nhật trong ứng dụng không áp dụng. Bất cứ thứ gì cần cửa sổ — bảng AI, lượt kiểm tra chất lượng trên một trang chiếu đã kết xuất — đều phải chờ bạn mở tệp ra. `ieumoffice render` đưa cho bạn các điểm ảnh mà không cần cửa sổ, và `ieumoffice slides` tự kiểm tra bố cục của một bộ trình chiếu.
