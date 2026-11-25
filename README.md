# nex-trace — theo dõi luồng chạy của Claude Code

Dashboard cục bộ cho biết **Claude đã dùng skill nào, gọi đi đâu (tool, MCP server, web, shell, subagent) và tốn bao nhiêu token / chi phí**, để bạn đánh giá skill nào hiệu quả và tối ưu lại.

Không cần cài thêm gì (chỉ cần Node ≥ 18, không có dependency). Dữ liệu đọc thẳng từ transcript mà Claude Code đã tự ghi ở `~/.claude/projects/**/*.jsonl`. Không có gì gửi ra ngoài máy.

## Chạy

```bash
git clone <repo> && cd nex-orchestrator
node bin/nex-trace.mjs serve            # mở http://127.0.0.1:7788
```

| Lệnh | Tác dụng |
|---|---|
| `nex-trace serve [--port 7788] [--days 30]` | Dashboard web, bấm ↻ để đọc lại transcript mới |
| `nex-trace report [--days 7]` | Bảng tóm tắt ngay trong terminal |
| `nex-trace build --out report.html` | Xuất 1 file HTML độc lập (gửi cho người khác xem) |
| `nex-trace json --out data.json` | Xuất dữ liệu thô |
| `nex-trace statusline` | Status line cho Claude Code (xem bên dưới) |

Tuỳ chọn chung: `--dir <thư mục projects>` (mặc định `~/.claude/projects`, hoặc biến `CLAUDE_PROJECTS_DIR` / `CLAUDE_CONFIG_DIR`).

## Dashboard có gì

- **Overview** — số session, API call, tổng token, chi phí ước tính, tỉ lệ cache, biểu đồ chi phí theo ngày, và **gợi ý tối ưu** tự động (skill nạp prompt quá lớn, tỉ lệ lỗi tool cao, tool trả về output quá dài, subagent tốn nhiều…).
- **Skills** — mỗi skill: số lượt gọi, chi phí/lượt, token/lượt, output/lượt, kích thước SKILL.md nạp vào, số tool call/lượt, % lỗi, tỉ lệ cache, token của subagent, thời lượng. Bấm vào skill → danh sách từng lượt gọi + skill đó **gọi đi đâu**; bấm vào một lượt → timeline chi tiết từng API call (input / cache write / cache read / output) và từng tool call.
- **Tool Calls** — mọi đích mà tool call đi tới: `mcp:<server>`, `web:<domain>`, `shell:<lệnh>`, `file:*`, `agent:<loại>`, `skill:<tên>`… với số lần, lỗi, thời gian trung bình, lượng token kết quả đổ vào context, và skill nào gọi.
- **Sessions** — từng phiên, từng lượt hỏi, timeline đầy đủ, subagent lồng bên trong.

## Status line ngay trong Claude Code

Thêm vào `~/.claude/settings.json`:

```json
{
  "statusLine": { "type": "command", "command": "node /đường/dẫn/nex-orchestrator/bin/nex-trace.mjs statusline" }
}
```

Hiển thị dưới ô nhập: `⚡dataviz · ctx 186k · 2.36M tok · ~$2.26 · 17 tools · skills: claude-api,dataviz`.

## Cách tính

- **Token** lấy từ `usage` của từng API response trong transcript (gộp các bản ghi trùng cùng `message.id`). "Tokens" = input + cache write + cache read + output (output đã gồm thinking).
- **Chi phí** là *ước tính theo giá API* (`src/pricing.mjs`). Nếu bạn dùng gói Pro/Max thì không trả theo token — hãy coi đây là thước đo để so sánh skill với nhau. Đổi bảng giá: `NEX_PRICING=/path/pricing.json` với dạng `{"claude-opus-5-5": {"input": 4, "output": 20, "cacheRead": 0.2}}`.
- **Gán cho skill**: một skill được tính là "đang chạy" từ API call ngay sau khi Claude gọi `Skill` (hoặc bạn gõ `/tên-skill`) cho đến hết lượt trả lời đó, hoặc đến khi skill khác được gọi. Subagent được sinh ra trong lúc đó tính vào skill này. Nghĩa là nếu Claude dùng skill xong rồi làm tiếp việc khác trong cùng lượt, phần việc sau vẫn bị tính vào skill.
- **Prompt skill** ≈ số ký tự nội dung SKILL.md được nạp / 4.
- **~Tokens trả về** của tool ≈ số ký tự kết quả / 4 — phần này nằm lại trong context và bị tính tiền (dưới dạng cache read) ở mọi lượt sau.

## Giới hạn

- Chỉ thấy được những gì Claude Code ghi vào transcript trên máy chạy lệnh. Cuộc trò chuyện trên claude.ai (web/app) không có transcript cục bộ nên không theo dõi được bằng công cụ này.
- Transcript cũ (lưu subagent ngay trong file chính với `isSidechain`) chưa được tách thành subagent riêng.
