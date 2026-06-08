# Arc Swim Rota — blog deliverables

Two versions of the same article about building the app with Claude Code, plus the screenshots.

| File | What it is | How to use it |
|------|------------|---------------|
| [`arc-swim-rota-blog.md`](arc-swim-rota-blog.md) | Clean Markdown version (~2,000 words) | Read it, or paste into any Markdown-aware CMS/editor. |
| [`arc-swim-rota-gutenberg.html`](arc-swim-rota-gutenberg.html) | WordPress **Gutenberg block** version | New post → ⋮ menu → **Code editor** → paste the whole file → switch to **Visual editor**. |
| [`img/`](img/) | 12 phone-resolution screenshots (860×1760, 2×) | Upload to the WordPress Media Library. |

## Importing into WordPress (Gutenberg)

1. **Posts → Add New.**
2. Click the **⋮ (Options)** button, top-right → **Code editor**.
3. Paste the entire contents of `arc-swim-rota-gutenberg.html`.
4. Switch back to the **Visual editor** (same ⋮ menu).
5. **Delete the yellow instructions block** at the very top.
6. Set the **post title** to *“Building a Swim-Club Rota App in Four Days with Claude Code.”*
7. **Upload the images:** drag the files from `img/` into the Media Library, then click each image block and re-select it from the library (or fix the `src`). The blocks currently reference `img/01-login.png` … `img/12-profile.png`.

## Screenshot index

| File | View | Used in post |
|------|------|:---:|
| `01-login.png` | Login screen | ✅ |
| `02-home-admin.png` | Admin home dashboard | — (spare) |
| `03-approvals.png` | Admin approvals queue | ✅ |
| `04-reports-coverage.png` | Coverage report | ✅ |
| `05-reports-training.png` | Training-status report | ✅ |
| `06-rota-builder.png` | Bulk rota builder | ✅ |
| `07-messages.png` | Channel list | — (spare) |
| `08-chat.png` | Lifeguards channel chat | ✅ |
| `09-home-staff.png` | Staff home dashboard | ✅ |
| `10-shifts-week.png` | Week timetable grid | ✅ |
| `11-myshifts.png` | My Shifts | — (spare) |
| `12-profile.png` | Staff profile / training | ✅ |
| `13-pending-requester.png` | Pending-requester modal (latest feature) | ✅ |

The three “spare” shots (`02`, `07`, `11`) aren’t embedded in the article but are included if you want to swap any in.

> The full code & deployment audit referenced near the end of the post lives in [`../AUDIT.md`](../AUDIT.md).
