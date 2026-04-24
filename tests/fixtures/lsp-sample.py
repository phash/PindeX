# tests/fixtures/lsp-sample.py
"""A sample Python module that would trip up a regex-based extractor."""
import os
from typing import Optional


class AuthService:
    """Auth service with a method that contains 'class Foo' in a string."""

    def __init__(self, token: str) -> None:
        self.token = token
        # This docstring-style comment contains "class Bait" which a regex
        # parser would misidentify as a class declaration.
        self._notice = "class Bait is not a real class"

    def authorize(self, user_id: str) -> Optional[str]:
        if not self.token:
            return None
        return f"{user_id}:{self.token}"


def greet(name: str) -> str:
    return f"hello {name}"


MAX_RETRIES = 3
