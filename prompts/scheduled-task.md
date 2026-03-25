Run this task: {{prompt}}

Current time: {{time}}.

If you have findings worth recording, write them to the taskboard at {{taskboardPath}}. Use this format:
## {{timestamp}} — {{taskName}}
<your findings here>

If something needs Randy's attention, also use send_message (chat_id: {{chatId}}).
If nothing is actionable and nothing to report, do NOT write to the taskboard and do NOT message. Silent exit.
