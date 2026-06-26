from __future__ import annotations

import json
from typing import AsyncGenerator

import httpx
from pydantic import BaseModel

from .config import GROQ_API_KEY

GROQ_URL = "https://api.groq.com/openai/v1/chat/completions"
CHAT_MODEL = "llama-3.1-8b-instant"


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
                "You are a smart, friendly study companion. "
                "Answer the user's question using ONLY the content provided below. "
                "If the answer is not in the content, say so honestly.\n\n"
                "FORMATTING RULES — follow these strictly:\n"
                "- Use **bold** for key terms and headings.\n"
                "- Use bullet points (`-`) for lists.\n"
                "- Wrap ALL mathematical expressions in LaTeX: inline math uses `$...$`, block equations use `$$...$$`.\n"
                "- Example: The distance formula is $r = \\sqrt{x^2 + y^2}$.\n"
                "- Example block: $$F = \\frac{k q_1 q_2}{r^2}$$\n"
                "- Never write raw equations like r = sqrt(x^2 + y^2). Always use LaTeX.\n"
                "- Be concise and clear."
            ),
        },
        {
            "role": "user",
            "content": (
                f"Page topic: {request.topic}\n"
                f"Page content:\n{page_content}\n\n"
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
