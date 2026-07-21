from __future__ import annotations

import json
import time
import urllib.request
from uuid import uuid4

import websocket


def target() -> dict:
    with urllib.request.urlopen("http://127.0.0.1:9222/json/list", timeout=5) as response:
        pages = json.load(response)
    if not pages:
        raise RuntimeError("No Electron renderer target")
    return pages[0]


class Cdp:
    def __init__(self) -> None:
        self.ws = websocket.create_connection(
            target()["webSocketDebuggerUrl"],
            origin="http://127.0.0.1:9222",
            timeout=15,
        )
        self.next_id = 1

    def evaluate(self, expression: str):
        call_id = self.next_id
        self.next_id += 1
        self.ws.send(json.dumps({
            "id": call_id,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
        }))
        while True:
            result = json.loads(self.ws.recv())
            if result.get("id") != call_id:
                continue
            if "exceptionDetails" in result.get("result", {}):
                raise RuntimeError(json.dumps(result["result"]["exceptionDetails"], ensure_ascii=False))
            return result.get("result", {}).get("result", {}).get("value")

    def close(self) -> None:
        self.ws.close()


def main() -> None:
    cdp = Cdp()
    try:
        identity_expression = "({title:document.title,href:location.href,ready:document.readyState,hasElectron:!!window.electronAPI,agentKeys:Object.keys(window.electronAPI?.agent||{}),workspaceId:new URL(location.href).searchParams.get('workspaceId')})"
        identity = cdp.evaluate(identity_expression)
        if str(identity.get("href", "")).startswith("chrome-error:"):
            desired_url = target()["url"]
            cdp.evaluate(f"location.replace({json.dumps(desired_url)})")
            time.sleep(3)
            cdp.close()
            cdp = Cdp()
            identity = cdp.evaluate(identity_expression)
        if not identity.get("hasElectron") or identity.get("ready") != "complete":
            raise AssertionError(identity)
        required = {"getRun", "resumeRun", "runStream"}
        if not required.issubset(set(identity.get("agentKeys", []))):
            raise AssertionError(identity)
        workspace_id = identity["workspaceId"]
        if not isinstance(workspace_id, str):
            raise AssertionError(identity)
        print(json.dumps({"identity": identity}, ensure_ascii=False))
        request_id = f"request_e2e_{uuid4().hex}"
        setup = f"""
        (async () => {{
          window.__agentE2eEvents = [];
          window.__agentE2eUnsub?.();
          window.__agentE2eUnsub = window.electronAPI.agent.runStream.onEvent(event => {{
            if (event.requestId === {json.dumps(request_id)}) window.__agentE2eEvents.push(event);
          }});
          return await window.electronAPI.agent.runStream.start(
            {json.dumps(request_id)},
            {json.dumps(workspace_id)},
            {{input:'调用 workspace_list 检查工作空间，然后用一句话说明检查完成；不要修改文件。', history:[]}}
          );
        }})()
        """
        started = cdp.evaluate(setup)
        if not started or not started.get("success"):
            raise AssertionError(started)
        run_id = started["data"]["runId"]
        deadline = time.time() + 120
        event_types: list[str] = []
        while time.time() < deadline:
            snapshot = cdp.evaluate("window.__agentE2eEvents || []") or []
            event_types = [str(item.get("type")) for item in snapshot]
            if "done" in event_types or "error" in event_types:
                break
            time.sleep(0.5)
        if "run_started" not in event_types or not ({"done", "error"} & set(event_types)):
            raise AssertionError({"runId": run_id, "eventTypes": event_types})
        persisted = cdp.evaluate(f"window.electronAPI.agent.getRun({json.dumps(workspace_id)}, {json.dumps(run_id)})")
        if not persisted or not persisted.get("success") or not persisted["data"].get("events"):
            raise AssertionError(persisted)

        parent_request_id = f"request_recovery_parent_{uuid4().hex}"
        child_request_id = f"request_recovery_child_{uuid4().hex}"
        recovery_setup = f"""
        (async () => {{
          window.__agentRecoveryEvents = [];
          window.__agentE2eUnsub?.();
          window.__agentE2eUnsub = window.electronAPI.agent.runStream.onEvent(event => window.__agentRecoveryEvents.push(event));
          const parent = await window.electronAPI.agent.runStream.start(
            {json.dumps(parent_request_id)},
            {json.dumps(workspace_id)},
            {{input:'先检查工作空间，再总结结果；不要修改文件。', history:[]}}
          );
          if (!parent.success) return {{parent}};
          const cancelled = await window.electronAPI.agent.runStream.cancel({json.dumps(parent_request_id)});
          const beforeResume = await window.electronAPI.agent.getRun({json.dumps(workspace_id)}, parent.data.runId);
          const child = await window.electronAPI.agent.resumeRun(
            {json.dumps(child_request_id)},
            {json.dumps(workspace_id)},
            parent.data.runId
          );
          return {{parent, cancelled, beforeResume, child}};
        }})()
        """
        recovery_started = cdp.evaluate(recovery_setup)
        for key in ("parent", "cancelled", "beforeResume", "child"):
            if not recovery_started.get(key, {}).get("success"):
                raise AssertionError(recovery_started)
        if not recovery_started["beforeResume"]["data"]["recovery"]["recoverable"]:
            raise AssertionError(recovery_started)
        child_run_id = recovery_started["child"]["data"]["runId"]
        deadline = time.time() + 120
        child_event_types: list[str] = []
        while time.time() < deadline:
            recovery_events = cdp.evaluate("window.__agentRecoveryEvents || []") or []
            child_event_types = [
                str(item.get("type")) for item in recovery_events
                if item.get("requestId") == child_request_id
            ]
            if "done" in child_event_types or "error" in child_event_types:
                break
            time.sleep(0.5)
        if "continuation_created" not in child_event_types or not ({"done", "error"} & set(child_event_types)):
            raise AssertionError({"childRunId": child_run_id, "eventTypes": child_event_types})
        child_persisted = cdp.evaluate(f"window.electronAPI.agent.getRun({json.dumps(workspace_id)}, {json.dumps(child_run_id)})")
        if not child_persisted.get("success") or child_persisted["data"]["run"].get("parentRunId") != recovery_started["parent"]["data"]["runId"]:
            raise AssertionError(child_persisted)
        parent_after_resume = cdp.evaluate(
            f"window.electronAPI.agent.getRun({json.dumps(workspace_id)}, {json.dumps(recovery_started['parent']['data']['runId'])})"
        )
        if parent_after_resume["data"]["recovery"]["recoverable"]:
            raise AssertionError(parent_after_resume)

        print(json.dumps({
            "electron": identity["title"],
            "workspaceId": workspace_id,
            "runId": run_id,
            "streamEventTypes": event_types,
            "persistedEvents": len(persisted["data"]["events"]),
            "recovery": persisted["data"]["recovery"],
            "continuation": {
                "parentRunId": recovery_started["parent"]["data"]["runId"],
                "childRunId": child_run_id,
                "eventTypes": child_event_types,
                "parentRecoverableBefore": recovery_started["beforeResume"]["data"]["recovery"]["recoverable"],
                "parentRecoverableAfter": parent_after_resume["data"]["recovery"]["recoverable"],
            },
        }, ensure_ascii=False))
    finally:
        cdp.close()


if __name__ == "__main__":
    main()
