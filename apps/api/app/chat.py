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
                "You are an expert academic tutor. Answer questions using ONLY the provided content.\n\n"
                "RESPONSE STYLE:\n"
                "- Professional academic tone\n"
                "- Use ### for section headings\n"
                "- Use numbered lists for steps\n"
                "- Use bullet points for properties\n\n"
                "MATH RULES — STRICTLY FOLLOW:\n"
                "- Write ALL math in LaTeX. NEVER write both LaTeX and plain text for the same expression.\n"
                "- Inline math: $expression$ — example: The angle is $\\phi = \\tan^{-1}(y/x)$\n"
                "- Block equations: $$expression$$ on its own line — example:\n"
                "  $$\\rho = \\sqrt{x^2 + y^2}$$\n"
                "- After a LaTeX expression, do NOT repeat it in plain text or unicode.\n"
                "- WRONG: 'given by $\\rho = \\sqrt{x^2+y^2}$ ρ=√(x²+y²)'\n"
                "- RIGHT: 'given by $\\rho = \\sqrt{x^2+y^2}$'\n"
                "- Use display math ($$) for standalone equations, inline math ($) inside sentences.\n"
                "- Variables mentioned in text must use inline math: write $x$, $y$, $\\rho$, not x, y, ρ"
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
