from __future__ import annotations

import json
from typing import AsyncGenerator

import httpx
from pydantic import BaseModel

from .config import GROQ_API_KEY

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
CHAT_MODEL = "llama-3.3-70b-versatile"


class PageChatRequest(BaseModel):
    document_id: str
    node_id: str
    topic: str
    summary: str
    content: str | None = None
    question: str


class PageChatResponse(BaseModel):
    answer: str


def _build_messages(request: PageChatRequest) -> list[dict]:
    page_content = request.content or request.summary or ""
    return [
        {
            "role": "system",
            "content": (
                "You are a helpful, friendly academic assistant. Answer every question directly and honestly.\n"
                "- For questions about the page content: answer using the content.\n"
                "- For general questions (like 'hi', 'free fire', 'what is gravity'): answer naturally and helpfully.\n"
                "- NEVER refuse to answer. NEVER say a topic is unrelated. NEVER lecture the user.\n"
                "- Keep responses concise. Match length to the question — short questions get short answers.\n"
                "- 'hi' → respond with a friendly greeting, offer to help.\n"
                "- 'free fire' → briefly explain what Free Fire is, then offer to help with the page topic.\n\n"
                "MATH RULES:\n"
                "- Write ALL math in LaTeX only. Never write the same expression in both LaTeX and plain text.\n"
                "- Inline: $expression$ — Block: $$expression$$\n"
                "- Write $x$, not x. Write $\\rho$, not ρ. One form per expression, never both."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Topic: {request.topic}\n\n"
                f"Content:\n{page_content}\n\n"
                f"Question: {request.question}"
            ),
        },
    ]


def _headers() -> dict:
    return {
        "Authorization": f"Bearer {GROQ_API_KEY}",
        "Content-Type": "application/json",
    }


async def answer_page_question(request: PageChatRequest) -> str:
    async with httpx.AsyncClient(timeout=30) as client:
        resp = await client.post(
            GROQ_URL,
            headers=_headers(),
            json={"model": CHAT_MODEL, "messages": _build_messages(request), "temperature": 0.0},
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"].strip()


async def stream_page_answer(request: PageChatRequest) -> AsyncGenerator[str, None]:
    payload = {
        "model": CHAT_MODEL,
        "messages": _build_messages(request),
        "temperature": 0.0,
        "stream": True,
    }
    async with httpx.AsyncClient(timeout=60) as client:
        async with client.stream("POST", GROQ_URL, headers=_headers(), json=payload) as resp:
            resp.raise_for_status()
            async for line in resp.aiter_lines():
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if data == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                    token = chunk["choices"][0]["delta"].get("content", "")
                    if token:
                        yield token
                except (json.JSONDecodeError, KeyError, IndexError):
                    continue
