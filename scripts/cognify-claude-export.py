#!/usr/bin/env python3
"""
Import Claude conversation export into Cognee.

Filters for conversations with personal/life content,
extracts human messages, and bulk-adds them to Cognee.

Usage:
  cd cognee-repo && python3 ../scripts/cognify-claude-export.py /path/to/export/folder

Two-phase approach:
  Phase 1: Add all texts to Cognee dataset (fast)
  Phase 2: Run cognify once on the whole dataset (slow but automatic)
"""
import json
import sys
import os
import asyncio

BATCH_CHAR_LIMIT = 8000
PERSONAL_KEYWORDS = [
    "phoenix", "diana", "family", "house", "health", "weight", "gym", "drink",
    "japan", "anime", "real estate", "rental", "mortgage", "bradenton", "sarasota",
    "edith", "codegraph", "capsule", "blog", "conference", "cfp", "career",
    "publix", "timeshare", "westgate", "court", "custody", "school",
    "budget", "savings", "investment", "parenting", "adhd", "goals",
    "travel", "driving", "relationship", "wedding", "birthday",
]


def extract_human_text(convo):
    texts = []
    for msg in convo.get("chat_messages", []):
        if msg.get("sender") == "human":
            for block in msg.get("content", []):
                if block.get("type") == "text" and block.get("text"):
                    texts.append(block["text"])
    return "\n\n".join(texts)


def is_personal(text):
    lower = text.lower()
    return any(k in lower for k in PERSONAL_KEYWORDS)


def chunk_text(text, limit):
    chunks = []
    paragraphs = text.split("\n\n")
    current = ""
    for p in paragraphs:
        if len(current) + len(p) + 2 > limit and current:
            chunks.append(current.strip())
            current = ""
        current += ("\n\n" if current else "") + p
    if current.strip():
        chunks.append(current.strip())
    return chunks


async def main():
    if len(sys.argv) < 2:
        print("Usage: python3 ../scripts/cognify-claude-export.py /path/to/export/folder")
        sys.exit(1)

    export_dir = sys.argv[1]
    convos_file = os.path.join(export_dir, "conversations.json")

    print(f"Loading {convos_file}...")
    with open(convos_file) as f:
        convos = json.load(f)

    # Filter personal conversations
    personal = []
    for c in convos:
        text = extract_human_text(c)
        if len(text) > 100 and is_personal(text):
            personal.append(c)

    print(f"Found {len(personal)} personal conversations out of {len(convos)} total")
    personal.sort(key=lambda c: c.get("created_at", ""))

    import cognee

    # Phase 1: Add all texts
    print("\n--- Phase 1: Adding texts to Cognee ---")
    total_chunks = 0
    for i, convo in enumerate(personal):
        text = extract_human_text(convo)
        date = convo.get("created_at", "")[:10]
        title = convo.get("name", "Untitled")
        header = f'Source: Claude conversation "{title}" ({date})'

        chunks = chunk_text(text, BATCH_CHAR_LIMIT)
        for chunk in chunks:
            total_chunks += 1
            payload = f"{header}\n\n{chunk}"
            try:
                await cognee.add(payload, dataset_name="claude_conversations")
            except Exception as e:
                print(f"\n  ERROR adding chunk {total_chunks}: {e}")

        print(f"\r  Added {i+1}/{len(personal)} conversations ({total_chunks} chunks)", end="", flush=True)

    print(f"\n  Total: {total_chunks} chunks added to dataset 'claude_conversations'")

    # Phase 2: Cognify the whole dataset
    print("\n--- Phase 2: Running cognify (this will take a while) ---")
    try:
        await cognee.cognify()
        print("  Cognify started. Check status with cognify_status MCP tool.")
    except Exception as e:
        print(f"  ERROR starting cognify: {e}")

    print("\nDone!")


if __name__ == "__main__":
    asyncio.run(main())
