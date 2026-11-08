# Chế độ tác tử

Tác tử lấy một thư mục bạn chọn làm dự án và chạy Claude Code hoặc Codex có trên máy tính này ngay trong thư mục đó. AI tự đọc tài liệu trong thư mục, tạo tệp mới, dùng kỹ năng và tập lệnh, và sửa các tài liệu đang mở trong GenOffice. Hãy dùng nó cho những việc cần dựa vào nhiều tài liệu.

## Cần chuẩn bị

- Chương trình Claude Code hoặc Codex đã kết nối trong **Cài đặt ▸ AI** (đăng nhập bằng gói đăng ký Claude hoặc gói ChatGPT). Tác tử không dùng ChatGPT kết nối trực tiếp trong ứng dụng. Chủ đề "Kết nối gói đăng ký" giải thích cách làm.
- Một thư mục chứa tài liệu của bạn. Không thể chọn cả một ổ đĩa, toàn bộ thư mục người dùng, hay thư mục chứa dữ liệu đăng nhập hoặc dữ liệu ứng dụng.

## Bắt đầu một phiên

1. Ở thanh bên trái của Trang chủ, nhấn **Tác tử**. Cửa sổ tác tử sẽ mở riêng.
2. Nhấn **Chọn thư mục…** để chọn thư mục dự án. Các thư mục bạn dùng gần đây được liệt kê dưới **Thư mục gần đây**.
3. Trong **Chương trình**, chọn Claude Code hoặc Codex. Không thể chọn chương trình chưa được kết nối.
4. Trong **Khi nào hỏi bạn**, chọn cách tác tử xin phép (xem bảng bên dưới).
5. Lần đầu tiên, hãy đọc **Trước khi bắt đầu** rồi nhấn **Tôi đã hiểu**.
6. Nhấn **Bắt đầu**, viết điều bạn muốn làm, rồi nhấn **Gửi**.

Mỗi cửa sổ là một phiên. Đóng cửa sổ hoặc nhấn **Dừng** sẽ kết thúc phiên, và chương trình mà GenOffice đã khởi động cho phiên đó cũng tắt theo. Phiên cũng kết thúc nếu bạn không gửi gì trong 30 phút.

## Cách tác tử hỏi

| Lựa chọn                           | Làm ngay                                                 | Hỏi trước                                               |
| ---------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- |
| **Hỏi trước mỗi lệnh** (mặc định)  | Đọc và ghi tệp trong thư mục dự án, sửa tài liệu đang mở | Chạy lệnh hoặc tập lệnh, đọc bên ngoài thư mục dự án    |
| **Hỏi trước khi ghi và chạy lệnh** | Đọc tệp trong thư mục dự án, sửa tài liệu đang mở        | Ghi tệp, chạy lệnh hoặc tập lệnh, đọc bên ngoài thư mục |
| **Tin tưởng dự án này**            | Gần như mọi thứ                                          | Đọc bên ngoài thư mục dự án                             |

Khi tác tử hỏi, cửa sổ sẽ cho thấy nó muốn làm gì (toàn bộ lệnh, đường dẫn tệp). Nhấn **Cho phép** hoặc **Từ chối**.

Dù bạn chọn cách nào, tác tử cũng không:

- Ghi đè lên tệp của một tài liệu đang mở trong một thẻ GenOffice. Tài liệu đang mở được sửa thông qua ứng dụng, nên thay đổi hiện ngay trong trình soạn thảo và có thể hoàn tác bằng chức năng hoàn tác của trình soạn thảo.
- Ghi ra bên ngoài thư mục dự án.
- Đụng đến dữ liệu đăng nhập của Claude hay Codex, hoặc thư mục dữ liệu của GenOffice.

## Claude Code và Codex

- **Codex** chạy lệnh trong không gian cách ly riêng của nó, kể cả những lệnh bạn cho phép. Nó chỉ có thể ghi vào thư mục dự án, internet bị chặn trừ khi bạn bật lên, và nó không đọc được các tệp cá nhân của bạn bên ngoài dự án. Khi một phiên bắt đầu, GenOffice kiểm tra trước xem việc cách ly này có hoạt động trên máy tính này không, và sẽ không khởi động nếu không.
- **Claude Code** không thể cách ly lệnh trên Windows. Một lệnh bạn cho phép có thể truy cập toàn bộ máy tính và internet. Vì vậy, với **Tin tưởng dự án này**, bộ kiểm tra riêng của Claude Code sẽ thay bạn kiểm tra từng hành động.

Tài liệu người khác gửi cho bạn có thể chứa chỉ dẫn ẩn bảo AI làm việc khác. Với thư mục chứa tài liệu bạn không rõ nguồn gốc, hãy dùng một trong các lựa chọn có hỏi.

## Tìm kiếm web và internet

- **Claude Code** có thể tìm kiếm trên web và đọc trang web, nhưng sẽ hỏi trước. Nó hỏi vào lần tìm kiếm đầu tiên, và hỏi cho từng trang web mà nó muốn đọc. Trong câu hỏi đó, **Cho phép tìm kiếm trong phiên này** hoặc **Cho phép trang này trong phiên này** giúp nó không hỏi lại cho đến hết phiên. Với **Tin tưởng dự án này**, bộ kiểm tra riêng của Claude Code sẽ quyết định.
- Khi bạn chọn **Codex**, màn hình bắt đầu có thêm hai cài đặt.

| Cài đặt                        | Lựa chọn                         | Ban đầu        |
| ------------------------------ | -------------------------------- | -------------- |
| **Tìm kiếm web**               | Kết quả đã lưu / Trực tiếp / Tắt | Kết quả đã lưu |
| **Truy cập internet của lệnh** | Tắt / Bật                        | Tắt            |

- Kết quả đã lưu lấy từ nội dung web được thu thập sẵn; Trực tiếp tìm trên web như hiện tại.
- Cả hai cài đặt được ghi nhớ riêng cho từng thư mục dự án. Thư mục dùng lần đầu sẽ bắt đầu với các giá trị ở trên.
- Khi bật truy cập internet của lệnh, các lệnh mà Codex chạy có thể truy cập internet. Với **Tin tưởng dự án này**, lệnh truy cập mà không hỏi, và chỉ dẫn ẩn trong tài liệu bạn nhận được có thể khiến dữ liệu của bạn bị gửi ra ngoài. Cảnh báo này hiện ra khi bạn bật nó. Chỉ bật khi thật sự cần. Kỹ năng có sẵn "Tìm kỹ năng" chỉ hoạt động khi cài đặt này đang bật.

## Ghi chú dự án và kỹ năng

- Nếu thư mục có `CLAUDE.md` hoặc `AGENTS.md`, nội dung của tệp đó được đưa cho tác tử làm chỉ dẫn. Hãy ghi vào đó những điều cần giữ mỗi lần: giọng văn, thuật ngữ, định dạng của tài liệu cần tạo.
- Cửa sổ tác tử dùng các kỹ năng đang bật trong **Cài đặt ▸ Kỹ năng**. Claude Code và Codex nhận cùng một danh sách. Xem thêm về kỹ năng trong [Kỹ năng](help://skills).
- Các kỹ năng trong `.claude/skills` và `.agents/skills` của thư mục dự án được dùng trong phiên đó mà không cần bật.
- Chọn một kỹ năng bằng `/` hoặc `$` trong ô nhập, và một chỉ dẫn yêu cầu đọc rồi làm theo kỹ năng đó sẽ được đặt trước yêu cầu của bạn.
- Danh sách kỹ năng được cố định khi phiên bắt đầu. Nếu bạn bật hoặc tắt kỹ năng trong lúc phiên đang chạy, dòng "Kỹ năng đã thay đổi được áp dụng từ phiên tiếp theo" sẽ hiện ra.
- Khi tác tử tạo một kỹ năng, thẻ kỹ năng sẽ hiện trong cửa sổ; khi nó tìm thấy một kỹ năng đáng cài, bản xem trước cài đặt sẽ hiện ra. Không có gì được lưu hay cài đặt cho đến khi bạn nhấn **Lưu** hoặc **Cài đặt**, và kỹ năng đã cài dùng được từ phiên tiếp theo.
- Các chương trình mà tập lệnh của kỹ năng sử dụng (Python, v.v.) phải được cài trên máy tính này.
- Nếu bạn đã dùng tác tử ở phiên bản trước, lần đầu mở cửa sổ tác tử sẽ có một thông báo hiện một lần: "Kỹ năng giờ được bật và tắt trong Cài đặt → Kỹ năng. Các kỹ năng trong thư mục kỹ năng của Claude và Codex lúc đầu ở trạng thái tắt." **Mở Cài đặt** đưa bạn thẳng đến đó.

## Tệp mới và tài liệu đang mở

- Tệp mới do tác tử tạo được lưu trong thư mục dự án. Nhấn **Mở** ở dòng đó trong nhật ký tiến trình để mở tệp trong một thẻ GenOffice.
- Để tác tử sửa một tài liệu đang mở, trước tiên hãy mở tài liệu đó trong GenOffice rồi nêu tên nó trong yêu cầu.
- Tài liệu bạn mở trong lúc phiên đang chạy có thể được sửa từ tin nhắn tiếp theo của bạn.

## Quyền riêng tư và mức sử dụng

- Những gì bạn đã ẩn khỏi AI chỉ được giữ kín khi ứng dụng đọc một tài liệu đang mở trong GenOffice cho tác tử. Các tệp tác tử tự đọc từ thư mục sẽ được gửi nguyên trạng.
- Từ khóa tìm kiếm web và địa chỉ các trang được đọc sẽ được gửi đến công ty của chương trình và đến các trang web đó. Khi bật truy cập internet của lệnh cho Codex, dữ liệu có thể đi đến bất cứ nơi nào lệnh kết nối tới.
- Tác tử làm việc qua nhiều bước, nên dùng nhiều hạn mức gói đăng ký của bạn hơn bảng AI. Khi hết hạn mức, yêu cầu sẽ thất bại; tác tử không bao giờ chuyển sang AI khác hay sang một kết nối tính phí.

## Nếu có sự cố

| Cửa sổ hiển thị                               | Việc cần làm                                          |
| --------------------------------------------- | ----------------------------------------------------- |
| **Chưa kết nối**                              | Đăng nhập vào chương trình đó trong **Cài đặt ▸ AI**. |
| **Không thể dùng thư mục này**                | Chọn một thư mục chỉ chứa tài liệu công việc của bạn. |
| **Codex không thể mở hộp cát**                | Cập nhật Windows, hoặc chọn Claude Code.              |
| **Bạn đã dùng hết hạn mức gói đăng ký**       | Gửi lại sau khi hạn mức được đặt lại.                 |
| **Chương trình quá cũ để dùng chế độ tác tử** | Cập nhật chương trình đó, rồi nhấn **Phiên mới**.     |
