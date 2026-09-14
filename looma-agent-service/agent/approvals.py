from __future__ import annotations

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Literal


ApprovalStatus = Literal["approved", "rejected", "expired", "cancelled"]


def utc_iso_z(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


@dataclass(frozen=True)
class ApprovalResolution:
    status: ApprovalStatus
    reason: str | None = None
    resolved_at: str | None = None
    applied: bool | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "status": self.status,
            "reason": self.reason,
            "resolvedAt": self.resolved_at,
            "applied": self.applied,
        }


@dataclass
class PendingApproval:
    approval_id: str
    run_id: str
    step_id: str
    call_id: str
    tool_name: str
    payload: dict[str, Any]
    requested_at: str
    deadline_at: str
    _future: asyncio.Future[ApprovalResolution] = field(repr=False)

    def as_event(self) -> dict[str, Any]:
        return {
            "approvalId": self.approval_id,
            "stepId": self.step_id,
            "callId": self.call_id,
            "tool": self.tool_name,
            "proposal": self.payload,
            "requestedAt": self.requested_at,
            "deadlineAt": self.deadline_at,
        }


class ApprovalManager:
    def __init__(self, *, default_timeout_seconds: float = 300.0) -> None:
        if default_timeout_seconds <= 0:
            raise ValueError("default_timeout_seconds must be positive")
        self._default_timeout_seconds = float(default_timeout_seconds)
        self._pending: dict[str, PendingApproval] = {}
        self._lock = asyncio.Lock()

    def create(
        self,
        *,
        run_id: str,
        step_id: str,
        call_id: str,
        tool_name: str,
        payload: dict[str, Any],
        timeout_seconds: float | None = None,
    ) -> PendingApproval:
        loop = asyncio.get_running_loop()
        now = datetime.now(timezone.utc)
        deadline = now + timedelta(seconds=timeout_seconds or self._default_timeout_seconds)
        approval = PendingApproval(
            approval_id=f"approval_{uuid.uuid4().hex}",
            run_id=run_id,
            step_id=step_id,
            call_id=call_id,
            tool_name=tool_name,
            payload=payload,
            requested_at=utc_iso_z(now),
            deadline_at=utc_iso_z(deadline),
            _future=loop.create_future(),
        )
        self._pending[approval.approval_id] = approval
        return approval

    async def resolve(self, approval_id: str, resolution: ApprovalResolution) -> PendingApproval:
        async with self._lock:
            approval = self._pending.get(approval_id)
            if approval is None:
                raise KeyError(approval_id)
            if approval._future.done():
                return approval
            resolved_at = resolution.resolved_at or utc_iso_z(datetime.now(timezone.utc))
            approval._future.set_result(
                ApprovalResolution(
                    status=resolution.status,
                    reason=resolution.reason,
                    resolved_at=resolved_at,
                    applied=resolution.applied,
                )
            )
            return approval

    async def wait_for_resolution(self, approval_id: str) -> ApprovalResolution:
        approval = self._pending.get(approval_id)
        if approval is None:
            raise KeyError(approval_id)

        timeout = max(
            0.0,
            (
                datetime.fromisoformat(approval.deadline_at.replace("Z", "+00:00"))
                - datetime.now(timezone.utc)
            ).total_seconds(),
        )
        try:
            return await asyncio.wait_for(asyncio.shield(approval._future), timeout=timeout)
        except asyncio.TimeoutError:
            await self.resolve(
                approval_id,
                ApprovalResolution(status="expired", reason="approval timed out"),
            )
            return await asyncio.shield(approval._future)
        finally:
            self._pending.pop(approval_id, None)

    async def cancel_run(self, run_id: str) -> None:
        for approval in list(self._pending.values()):
            if approval.run_id != run_id:
                continue
            await self.resolve(
                approval.approval_id,
                ApprovalResolution(status="cancelled", reason="run cancelled"),
            )

    def has_pending(self, approval_id: str) -> bool:
        return approval_id in self._pending

    def pending_approvals(self) -> tuple[PendingApproval, ...]:
        return tuple(self._pending.values())
