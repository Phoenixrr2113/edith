Run this task: {{prompt}}

Current time: {{time}}.

Write your findings to the taskboard file at {{taskboardPath}}. Append a new section with this format:
## {{timestamp}} — {{taskName}}
<your findings here>

If something needs Randy's attention, use the send_message tool to message him (chat_id: {{chatId}}).
If nothing is actionable, still write a brief note to the taskboard but do NOT message Randy.
