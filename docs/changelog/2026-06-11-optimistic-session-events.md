# Optimistic session event sync

- New sessions can open their events stream before the server insert has reconciled, so the live trace no longer gets stuck after a one-time 403 during creation.
- Existing sessions owned by another user still return 403 for events and controls sync.
