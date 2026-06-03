# Surgical File Edits

- Added `edit_file` for exact single-string replacements and `multi_edit` for ordered atomic edits to one file.
- File-mutating proposals now include before/after content for `write_file`, `edit_file`, and `multi_edit` so the approval UI can render the proposed diff before execution.
