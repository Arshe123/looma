import json
from pathlib import Path
import tempfile
import unittest

from agent.events import tool_result_event
from agent.models import ToolResult
from agent.prompts import observation_prompt
from agent.tools.base import AgentToolContext
from agent.tools.file_read import FileReadTool
from agent.tools.registry import ToolRegistry
from agent.tools.rag_search import RagSearchTool
from test.test_agent_rag_tool import make_context


class AgentObservationTest(unittest.TestCase):
    def test_rag_metadata_cannot_crowd_out_text_and_citation(self):
        metadata = {"path": "notes/release.md", "page_label": "3"}
        metadata.update({str(index).zfill(100): "v" * 64 for index in range(100)})
        result = ToolResult(tool="rag_search", success=True, summary="Found", data={
            "status": "ok", "query": "release", "count": 1,
            "sources": [{"text": "Release is Friday.", "metadata": metadata}],
        })
        observation = json.loads(observation_prompt(result))
        sources = observation["modelContext"]["structuredData"].get("sources")
        self.assertTrue(sources)
        self.assertEqual(sources[0]["text"], "Release is Friday.")
        self.assertEqual(sources[0]["metadata"]["path"], "notes/release.md")

    def test_generic_string_clipping_is_visible_and_reported(self):
        result = ToolResult(tool="workspace_search", success=True, summary="Found", data={
            "matches": [{"snippet": "x" * 5000, "password": "DO_NOT_EXPOSE"}],
        })
        persisted = tool_result_event("r", step=1, step_id="s", call_id="c", result=result,
                                      duration_ms=0)["result"]
        for view in (json.loads(observation_prompt(result)), persisted):
            data = view["modelContext"]["structuredData"]
            self.assertTrue(view["truncated"])
            self.assertTrue(data["truncated"])
            self.assertTrue(data["matches"][0]["snippet"].endswith("[truncated]"))
            self.assertNotIn("DO_NOT_EXPOSE", json.dumps(view))

    def test_large_rag_retains_ranked_evidence_with_explicit_bounds(self):
        sources = [{"text": "relevant evidence " * 500, "score": 0.9,
                    "metadata": {"path": f"notes/{index}.md", "secret": "DO_NOT_EXPOSE"}}
                   for index in range(50)]
        result = ToolResult(tool="rag_search", success=True, summary="Found", data={
            "status": "ok", "query": "evidence", "count": len(sources), "sources": sources,
        })
        rendered = observation_prompt(result)
        self.assertLessEqual(len(rendered), 12000)
        persisted = tool_result_event("r", step=1, step_id="s", call_id="c", result=result,
                                      duration_ms=0)["result"]
        self.assertLessEqual(len(json.dumps(persisted["modelContext"], ensure_ascii=False,
                                            separators=(",", ":"))), 24000)
        for view in (json.loads(rendered), persisted):
            data = view["modelContext"]["structuredData"]
            self.assertTrue(data.get("sources"))
            self.assertEqual(data["sources"][0]["metadata"]["path"], "notes/0.md")
            self.assertTrue(data["sources"][0]["text"].startswith("relevant evidence"))
            self.assertTrue(data["sources"][0]["textTruncated"])
            self.assertTrue(view["truncated"])
            self.assertEqual(data["count"], 50)
            self.assertEqual(data["returnedSourceCount"], len(data["sources"]))
            self.assertNotIn("DO_NOT_EXPOSE", json.dumps(view))

    def test_file_read_content_is_complete_or_has_accurate_continuation(self):
        content = "a useful line of file content.\n" * 417
        result = ToolResult(tool="file_read", success=True, summary="Read", data={
            "status": "ok", "path": "notes/long.md", "content": content,
            "startLine": 1, "endLine": 417, "totalLines": 417, "truncated": False,
        })
        persisted = tool_result_event("run", step=1, step_id="s", call_id="c",
                                      result=result, duration_ms=0)["result"]
        self.assertEqual(persisted["modelContext"]["structuredData"]["content"], content)
        rendered = observation_prompt(result)
        self.assertLessEqual(len(rendered), 12000)
        live = json.loads(rendered)
        data = live["modelContext"]["structuredData"]
        self.assertTrue(data["content"])
        self.assertTrue(content.startswith(data["content"]))
        self.assertTrue(live["truncated"])
        self.assertTrue(data["truncated"])
        self.assertEqual(data["endLine"], data["content"].count("\n") + (not data["content"].endswith("\n")))
        self.assertEqual(data["nextStartLine"], data["content"].count("\n") + 1)
        self.assertEqual(data["nextStartColumn"], len(data["content"].rsplit("\n", 1)[-1]) + 1)
        self.assertEqual(data["totalLines"], 417)

    def test_rag_evidence_reaches_live_and_persisted_model_context(self):
        result = ToolResult(tool="rag_search", success=True, summary="Found a source", data={
            "status": "ok", "query": "release", "count": 1,
            "sources": [{"text": "Release is planned for Friday.", "score": 0.9,
                         "metadata": {"path": "notes/release.md", "page_label": "3",
                                      "api_key": "DO_NOT_EXPOSE"}}],
        })
        live = json.loads(observation_prompt(result))["modelContext"]
        persisted = tool_result_event("run", step=1, step_id="s", call_id="c",
                                      result=result, duration_ms=0)["result"]["modelContext"]
        for context in (live, persisted):
            source = context["structuredData"]["sources"][0]
            self.assertEqual(source["text"], "Release is planned for Friday.")
            self.assertEqual(source["metadata"]["path"], "notes/release.md")
            self.assertEqual(source["metadata"]["page_label"], "3")
            self.assertNotIn("DO_NOT_EXPOSE", json.dumps(context))


class AgentObservationRegistryTest(unittest.IsolatedAsyncioTestCase):
    async def test_large_rag_registry_preserves_sanitizable_sources(self):
        async def retrieve(_request):
            return [{"text": "evidence " * 1000, "score": 0.9,
                     "metadata": {"path": f"notes/{index}.md", "authorization": "DO_NOT_EXPOSE"}}
                    for index in range(10)]

        registry = ToolRegistry(allowed_tools=["rag_search"])
        registry.register(RagSearchTool(retriever=retrieve))
        result = await registry.execute("rag_search", make_context("."), {"query": "evidence"},
                                        enabled_tools=["rag_search"])
        self.assertTrue(result.success)
        self.assertTrue(isinstance(result.data, dict), "Registry must not turn evidence into a JSON fragment")
        self.assertTrue(result.truncated)
        self.assertLessEqual(len(json.dumps(result.data, ensure_ascii=False, separators=(",", ":"))), 20000)
        for data in (result.data, json.loads(observation_prompt(result))["modelContext"]["structuredData"]):
            self.assertTrue(data["sources"][0]["text"])
            self.assertEqual(data["sources"][0]["metadata"]["path"], "notes/0.md")
            self.assertNotIn("DO_NOT_EXPOSE", json.dumps(data))

    async def test_large_real_file_read_stays_structured_through_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            content = ('quoted "text" \\ and a newline\n' * 2000)
            Path(directory, "long.md").write_text(content, encoding="utf-8")
            registry = ToolRegistry(allowed_tools=["file_read"])
            registry.register(FileReadTool())
            result = await registry.execute("file_read", AgentToolContext(workspace_path=directory),
                                            {"path": "long.md", "max_chars": 50000},
                                            enabled_tools=["file_read"])
        self.assertTrue(result.success)
        self.assertIsInstance(result.data, dict)
        self.assertEqual(result.data["path"], "long.md")
        self.assertTrue(result.truncated)
        self.assertLessEqual(len(json.dumps(result.data, ensure_ascii=False, separators=(",", ":"))), 20000)
        for view in (json.loads(observation_prompt(result))["modelContext"],
                     tool_result_event("r", step=1, step_id="s", call_id="c", result=result,
                                       duration_ms=0)["result"]["modelContext"]):
            data = view["structuredData"]
            self.assertTrue(data["content"])
            self.assertTrue(content.startswith(data["content"]))
            self.assertTrue(data["truncated"])
            self.assertEqual(data["availableContentChars"], 50000)
            self.assertEqual(data["nextStartLine"], data["content"].count("\n") + 1)
            self.assertEqual(data["nextStartColumn"], len(data["content"].rsplit("\n", 1)[-1]) + 1)
