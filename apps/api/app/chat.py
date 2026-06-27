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
                "You are a knowledgeable academic tutor. Answer the user's question directly and helpfully.\n"
                "If the provided page content is relevant, use it. For general knowledge questions, answer from your knowledge.\n\n"
                "RESPONSE STYLE:\n"
                "- Match the response length to the question. Simple questions get short answers.\n"
                "- Only use headings (###) for complex multi-part responses.\n"
                "- Use plain sentences for simple factual questions.\n"
                "- Use numbered lists or bullets only when listing multiple items.\n"
                "- Never add unnecessary introductory phrases like 'Introduction to...' or 'Key Points about...'\n\n"
                "MATH RULES — CRITICAL:\n"
                "- Write ALL math expressions in LaTeX ONLY. Never write the same expression twice.\n"
                "- Inline: $x^2 + y^2$ — use inside sentences\n"
                "- Block: $$F = G\\frac{m_1 m_2}{r^2}$$ — use for standalone equations\n"
                "- After writing $\\rho = \\sqrt{x^2+y^2}$ do NOT write ρ=√(x²+y²) after it\n"
                "- One LaTeX expression per concept. Never duplicate.\n"
                "- Variables in text use inline math: write $x$, not x"
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
