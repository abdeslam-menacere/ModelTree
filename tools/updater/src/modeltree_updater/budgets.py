"""Per-creator page, token, time, and retry budgets.

Budgets are refused *before* work happens, and refusal is a typed outcome the
proposal carries. An exhausted budget must never look like "there was nothing to
find" — that distinction is the whole point of the ledger.
"""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Mapping

from .contracts import BudgetUsage

__all__ = ["BudgetExhausted", "BudgetLedger", "CreatorBudget"]

_ENV_PREFIX = "MODELTREE_UPDATER_"


@dataclass(frozen=True)
class CreatorBudget:
    """Limits applied to a single creator run."""

    max_pages: int = 8
    max_tokens: int = 40_000
    max_seconds: float = 120.0
    max_retries: int = 2

    def __post_init__(self) -> None:
        for name in ("max_pages", "max_tokens", "max_retries"):
            value = getattr(self, name)
            if not isinstance(value, int) or value < 0:
                raise ValueError(f"{name} must be a non-negative integer, got {value!r}")
        if self.max_seconds <= 0:
            raise ValueError(f"max_seconds must be positive, got {self.max_seconds!r}")

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "CreatorBudget":
        defaults = cls()
        return cls(
            max_pages=int(env.get(f"{_ENV_PREFIX}MAX_PAGES", defaults.max_pages)),
            max_tokens=int(env.get(f"{_ENV_PREFIX}MAX_TOKENS", defaults.max_tokens)),
            max_seconds=float(env.get(f"{_ENV_PREFIX}MAX_SECONDS", defaults.max_seconds)),
            max_retries=int(env.get(f"{_ENV_PREFIX}MAX_RETRIES", defaults.max_retries)),
        )


class BudgetExhausted(Exception):
    """Raised when a charge would exceed a limit. Carries what ran out."""

    def __init__(self, resource: str, *, limit: float, used: float, requested: float) -> None:
        super().__init__(
            f"{resource} budget exhausted: used {used} of {limit}, requested {requested} more"
        )
        self.resource = resource
        self.limit = limit
        self.used = used
        self.requested = requested


class BudgetLedger:
    """Mutable usage counter for one creator. The clock is injectable so tests are
    deterministic and a resumed run can continue from recorded elapsed time."""

    def __init__(
        self,
        budget: CreatorBudget,
        *,
        clock: Callable[[], float] = time.monotonic,
        pages_fetched: int = 0,
        tokens_used: int = 0,
        retries_used: int = 0,
        elapsed_seconds: float = 0.0,
    ) -> None:
        self.budget = budget
        self._clock = clock
        self._started_at = clock()
        self._carried_elapsed = elapsed_seconds
        self.pages_fetched = pages_fetched
        self.tokens_used = tokens_used
        self.retries_used = retries_used
        self._exhausted_by: list[str] = []

    @property
    def elapsed_seconds(self) -> float:
        return self._carried_elapsed + (self._clock() - self._started_at)

    def _exhaust(self, resource: str, *, limit: float, used: float, requested: float) -> None:
        if resource not in self._exhausted_by:
            self._exhausted_by.append(resource)
        raise BudgetExhausted(resource, limit=limit, used=used, requested=requested)

    def charge_pages(self, count: int = 1) -> None:
        self.check_time()
        if self.pages_fetched + count > self.budget.max_pages:
            self._exhaust(
                "pages",
                limit=self.budget.max_pages,
                used=self.pages_fetched,
                requested=count,
            )
        self.pages_fetched += count

    def charge_tokens(self, count: int) -> None:
        self.check_time()
        if self.tokens_used + count > self.budget.max_tokens:
            self._exhaust(
                "tokens",
                limit=self.budget.max_tokens,
                used=self.tokens_used,
                requested=count,
            )
        self.tokens_used += count

    def record_retry(self) -> None:
        if self.retries_used + 1 > self.budget.max_retries:
            self._exhaust(
                "retries",
                limit=self.budget.max_retries,
                used=self.retries_used,
                requested=1,
            )
        self.retries_used += 1

    def check_time(self) -> None:
        elapsed = self.elapsed_seconds
        if elapsed >= self.budget.max_seconds:
            self._exhaust(
                "seconds",
                limit=self.budget.max_seconds,
                used=elapsed,
                requested=0,
            )

    def snapshot(self) -> BudgetUsage:
        return BudgetUsage(
            pages_fetched=self.pages_fetched,
            tokens_used=self.tokens_used,
            elapsed_seconds=round(self.elapsed_seconds, 6),
            retries_used=self.retries_used,
            max_pages=self.budget.max_pages,
            max_tokens=self.budget.max_tokens,
            max_seconds=self.budget.max_seconds,
            max_retries=self.budget.max_retries,
            exhausted_by=tuple(self._exhausted_by),
        )

    def state(self) -> dict[str, float]:
        """JSON-safe counters so a resumed run keeps spending the same budget."""
        return {
            "pages_fetched": self.pages_fetched,
            "tokens_used": self.tokens_used,
            "retries_used": self.retries_used,
            "elapsed_seconds": self.elapsed_seconds,
        }

    @classmethod
    def from_state(
        cls,
        budget: CreatorBudget,
        state: Mapping[str, float],
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> "BudgetLedger":
        return cls(
            budget,
            clock=clock,
            pages_fetched=int(state.get("pages_fetched", 0)),
            tokens_used=int(state.get("tokens_used", 0)),
            retries_used=int(state.get("retries_used", 0)),
            elapsed_seconds=float(state.get("elapsed_seconds", 0.0)),
        )
