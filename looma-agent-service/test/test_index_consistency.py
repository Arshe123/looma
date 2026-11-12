import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from llama_index.core import Document, Settings
from llama_index.core.embeddings import MockEmbedding

from rag import index_manager as manager, index_service as service, query_service
from schemas import AIConfig, ChatModelConfig, EmbeddingModelConfig, IndexBuildRequest, IndexRequest, KnowledgeConfig, RagQueryRequest, WorkspaceContext


class IndexConsistencyTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.workspace = Path(self.temp.name).resolve()
        self.embedding = patch('rag.index_service.make_embedding_model', side_effect=lambda config: MockEmbedding(embed_dim=8))
        self.embedding.start()
        self.addCleanup(self.embedding.stop)
        self.request = IndexRequest(
            workspace=WorkspaceContext(workspace_path=str(self.workspace)),
            knowledge=KnowledgeConfig(),
            ai_config=AIConfig(
                chat=ChatModelConfig(provider='ollama', model='offline-test'),
                embedding=EmbeddingModelConfig(provider='ollama', model='offline-test', dimension=8),
            ),
        )
        self.persist_dir = service.get_persist_dir(self.workspace, self.request.knowledge.vector_store_path)

    def write_note(self, relative, text='Note content for indexing.'):
        path = self.workspace / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding='utf-8')
        return path

    def vector_sources(self):
        data = json.loads((self.persist_dir / 'default__vector_store.json').read_text())
        return sorted(metadata['source'] for metadata in data['metadata_dict'].values())

    def build(self):
        return manager.build_managed_index(self.request, 'full')

    def file_request(self, relative):
        return IndexBuildRequest(path=relative, **self.request.model_dump())

    def stored_bytes(self):
        return {str(path.relative_to(self.workspace)): path.read_bytes()
                for path in (self.workspace / '.looma').rglob('*') if path.is_file()}

    def test_reindex_failure_preserves_vectors_and_manifest(self):
        self.write_note('a.md')
        self.build()
        before = self.stored_bytes()
        with patch('rag.index_manager._insert_doc_vectors', side_effect=RuntimeError('injected insert failure')):
            with self.assertRaisesRegex(RuntimeError, 'injected insert failure'):
                manager.reindex_file(self.file_request('a.md'))
        self.assertEqual(self.stored_bytes(), before)

    def test_automatic_exclusions_are_not_manually_ignored(self):
        self.write_note('a.md')
        for relative in ('.secret.md', '.private/note.md', '.looma/note.md',
                         '.git/note.md', 'node_modules/note.md', 'image.png'):
            self.write_note(relative)
        snapshot = manager.build_status_snapshot(self.request)
        self.assertEqual([(item['path'], item['status']) for item in snapshot['files']],
                         [('a.md', 'not_indexed')])
        self.assertEqual(snapshot['summary']['ignored'], 0)
        self.build()
        self.assertEqual(self.vector_sources(), ['a.md'])

    def test_ignore_removes_only_target_vectors_and_persists_across_all_build_modes(self):
        note = self.write_note('a.md')
        self.write_note('nested/a.md')
        self.build()
        result = manager.ignore_file(self.file_request('a.md'))
        self.assertTrue(result['success'])
        self.assertGreater(result['vector_nodes_removed'], 0)
        self.assertEqual(note.read_text(), 'Note content for indexing.')
        self.assertEqual(self.vector_sources(), ['nested/a.md'])
        sources = query_service.retrieve_context_sources_sync(
            RagQueryRequest(question='note', **self.request.model_dump()))
        self.assertEqual([source['metadata']['source'] for source in sources], ['nested/a.md'])
        self.assertEqual(manager.get_file_chunks(self.file_request('a.md'))['chunks'], [])
        self.assertNotIn('a.md', manager.load_manifest(self.workspace)['files'])
        snapshot = manager.build_status_snapshot(self.request)
        self.assertEqual(snapshot['summary']['ignored'], 1)
        ignored = next(item for item in snapshot['files'] if item['path'] == 'a.md')
        self.assertEqual((ignored['status'], ignored['chunkCount']), ('ignored', 0))
        for mode in ('full', 'incremental', 'retry_failed'):
            manager.build_managed_index(self.request, mode)
            self.assertEqual(self.vector_sources(), ['nested/a.md'])
            self.assertEqual(manager.build_status_snapshot(self.request)['summary']['ignored'], 1)

    def test_unignore_returns_to_not_indexed_after_index_purge(self):
        self.write_note('a.md')
        self.build()
        manager.ignore_file(self.file_request('a.md'))
        manager.delete_index_data(self.file_request('a.md'))
        self.assertEqual(manager.build_status_snapshot(self.request)['summary']['ignored'], 1)
        result = manager.unignore_file(self.file_request('a.md'))
        self.assertTrue(result['success'])
        snapshot = manager.build_status_snapshot(self.request)
        self.assertEqual(snapshot['summary']['ignored'], 0)
        self.assertEqual(snapshot['summary']['notIndexed'], 1)
        self.assertFalse(snapshot['exists'])
        self.build()
        self.assertEqual(self.vector_sources(), ['a.md'])

    def test_single_file_reindex_cannot_bypass_manual_ignore(self):
        self.write_note('a.md')
        self.build()
        manager.ignore_file(self.file_request('a.md'))
        before = self.stored_bytes()
        with self.assertRaisesRegex(ValueError, '已忽略'):
            manager.reindex_file(self.file_request('a.md'))
        self.assertEqual(self.stored_bytes(), before)

    def test_case_aliases_share_ignore_identity_on_case_insensitive_filesystems(self):
        first = self.write_note('Notes/alias.md')
        (self.workspace / 'Notes/a.md').hardlink_to(first)
        if not (self.workspace / 'notes/A.md').exists():
            self.skipTest('需要大小写不敏感的文件系统')
        self.write_note('other.md')
        self.build()
        result = manager.ignore_file(self.file_request('notes/A.md'))
        self.assertEqual(result['path'], 'Notes/a.md')
        self.assertEqual(self.vector_sources(), ['Notes/alias.md', 'other.md'])
        self.build()
        self.assertEqual(self.vector_sources(), ['Notes/alias.md', 'other.md'])
        with self.assertRaisesRegex(ValueError, '已忽略'):
            manager.reindex_file(self.file_request('NOTES/A.md'))
        manager.unignore_file(self.file_request('notes/A.md'))
        self.assertEqual(manager.build_status_snapshot(self.request)['summary']['ignored'], 0)

    def test_ignore_rejects_incomplete_index_without_marking_file_ignored(self):
        self.write_note('a.md')
        self.build()
        (self.persist_dir / 'index_store.json').unlink()
        before = self.stored_bytes()
        result = manager.ignore_file(self.file_request('a.md'))
        self.assertFalse(result['success'])
        self.assertTrue(result['requiresRebuild'])
        self.assertEqual(self.stored_bytes(), before)

    def test_ignore_failure_rolls_back_vectors_manifest_and_ignore_settings(self):
        self.write_note('a.md')
        self.write_note('other.md')
        self.build()
        manager.ignore_file(self.file_request('other.md'))
        before = self.stored_bytes()
        with patch.object(manager, 'save_ignored_files', side_effect=OSError('write failed')):
            with self.assertRaisesRegex(OSError, 'write failed'):
                manager.ignore_file(self.file_request('a.md'))
        self.assertEqual(self.stored_bytes(), before)
        replace = Path.replace

        def fail_publish(path, target):
            if path.name == 'new' and target == self.persist_dir:
                raise OSError('rename failed')
            return replace(path, target)

        with patch.object(Path, 'replace', fail_publish):
            with self.assertRaisesRegex(OSError, 'rename failed'):
                manager.ignore_file(self.file_request('a.md'))
        self.assertEqual(self.stored_bytes(), before)
        self.assertEqual(self.vector_sources(), ['a.md'])

    def test_ignore_handles_no_index_missing_file_and_repeated_operations(self):
        note = self.write_note('a.md')
        for _ in range(2):
            self.assertTrue(manager.ignore_file(self.file_request('a.md'))['success'])
        self.assertFalse(self.persist_dir.exists())
        self.assertEqual(manager.build_status_snapshot(self.request)['summary']['ignored'], 1)
        note.unlink()
        self.assertEqual(manager.build_status_snapshot(self.request)['summary']['ignored'], 1)
        manager.unignore_file(self.file_request('a.md'))
        self.assertEqual(manager.build_status_snapshot(self.request)['files'], [])

    def test_ignore_validates_paths_and_automatic_exclusions(self):
        self.write_note('a.md')
        self.write_note('nested/a.md')
        self.write_note('.hidden.md')
        self.write_note('node_modules/a.md')
        self.write_note('image.png')
        self.build()
        before = self.stored_bytes()
        for relative in ('../a.md', '/a.md', 'C:\\a.md', 'C:a.md', './a.md', '',
                         'nested/../a.md', '.hidden.md', 'node_modules/a.md', 'image.png'):
            with self.subTest(path=relative), self.assertRaises(ValueError):
                manager.ignore_file(self.file_request(relative))
            self.assertEqual(self.stored_bytes(), before)
        manager.ignore_file(self.file_request('nested\\a.md'))
        self.assertEqual(self.vector_sources(), ['a.md'])
        ignored = [item['path'] for item in manager.build_status_snapshot(self.request)['files']
                   if item['status'] == 'ignored']
        self.assertEqual(ignored, ['nested/a.md'])

    def test_ignore_http_api_reads_back_persisted_state_and_validates_requests(self):
        import main
        from fastapi.testclient import TestClient

        self.write_note('a.md')
        self.write_note('other.md')
        self.build()
        client = TestClient(main.app, raise_server_exceptions=False)
        with patch.object(main, 'resolve_request_config', side_effect=lambda request: request):
            body = self.file_request('a.md').model_dump()
            response = client.post('/rag/index/file/ignore', json=body)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()['success'])
            self.assertEqual(self.vector_sources(), ['other.md'])
            self.assertEqual(manager.build_status_snapshot(self.request)['summary']['ignored'], 1)
            response = client.post('/rag/index/file/unignore', json=body)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.json()['success'])
            self.assertEqual(manager.build_status_snapshot(self.request)['summary']['notIndexed'], 1)
            body['path'] = '../a.md'
            for endpoint in ('ignore', 'unignore'):
                response = client.post(f'/rag/index/file/{endpoint}', json=body)
                self.assertEqual(response.status_code, 400)
                self.assertIn('相对路径', response.json()['detail'])

    def test_delete_bookkeeping_failure_preserves_old_index(self):
        self.write_note('a.md')
        self.build()
        before = self.stored_bytes()
        with patch.object(manager, 'save_manifest', side_effect=OSError('write failed')):
            with self.assertRaisesRegex(OSError, 'write failed'):
                manager.delete_file_index(self.file_request('a.md'))
        self.assertEqual(self.stored_bytes(), before)

    def test_failed_publication_restores_vectors_and_bookkeeping(self):
        self.write_note('a.md')
        self.build()
        before = self.stored_bytes()
        self.write_note('a.md', 'replacement content')
        replace = Path.replace

        def fail_publish(path, target):
            if path.name == 'new' and target == self.persist_dir:
                raise OSError('rename failed')
            return replace(path, target)

        with patch.object(Path, 'replace', fail_publish):
            with self.assertRaisesRegex(OSError, 'rename failed'):
                manager.reindex_file(self.file_request('a.md'))
        self.assertEqual(self.stored_bytes(), before)
        self.assertEqual(list(self.persist_dir.parent.glob('.*-update-*')), [])

    def test_delete_preserves_nested_file_with_same_basename(self):
        self.write_note('a.md')
        self.write_note('nested/a.md')
        self.build()
        result = manager.delete_file_index(self.file_request('a.md'))
        self.assertTrue(result['success'])
        self.assertEqual(self.vector_sources(), ['nested/a.md'])
        self.assertIn('nested/a.md', manager.load_manifest(self.workspace)['files'])

    def test_incremental_empty_corpus_removes_old_vectors(self):
        for empty_text in (None, '   \n'):
            with self.subTest(empty_text=empty_text):
                note = self.write_note('last.md')
                self.build()
                if empty_text is None:
                    note.unlink()
                else:
                    note.write_text(empty_text, encoding='utf-8')
                result = manager.build_managed_index(self.request, 'incremental')
                self.assertFalse(result['exists'])
                self.assertFalse(result['statusAfter']['exists'])
                self.assertFalse(service.has_index(self.workspace, '.looma/rag-index'))
                self.assertEqual(result['chunk_count'], 0)

    def test_build_stream_commits_empty_state(self):
        import main

        async def stream():
            response = await main.rag_index_build_stream(IndexBuildRequest(mode='full', **self.request.model_dump()))
            return [json.loads(line if isinstance(line, str) else bytes(line)) async for line in response.body_iterator]

        with patch.object(main, 'resolve_request_config', side_effect=lambda request: request):
            self.write_note('a.md')
            self.build()
            (self.workspace / 'a.md').unlink()
            events = asyncio.run(stream())
            self.assertEqual(events[-1]['type'], 'done')
            self.assertFalse(service.has_index(self.workspace, '.looma/rag-index'))
            self.assertEqual(manager.load_manifest(self.workspace)['files'], {})

    def test_full_build_failure_keeps_previous_index(self):
        self.write_note('a.md')
        self.build()
        before = self.stored_bytes()
        with patch('rag.index_manager.build_vector_index', side_effect=RuntimeError('injected build failure')):
            with self.assertRaisesRegex(RuntimeError, 'injected build failure'):
                self.build()
        self.assertEqual(self.stored_bytes(), before)

    def test_build_query_and_reindex_keep_operation_local_settings(self):
        self.write_note('a.md')
        marker_model = MockEmbedding(embed_dim=16)
        marker_transformations = service.make_node_transformations(KnowledgeConfig(chunking_strategy='markdown'))
        with patch.object(Settings, '_embed_model', marker_model), patch.object(Settings, '_transformations', marker_transformations):
            self.build()
            self.assertIs(Settings.embed_model, marker_model)
            self.assertIs(Settings.transformations, marker_transformations)
            index = query_service.load_index(RagQueryRequest(question='note', **self.request.model_dump()))
            self.assertEqual(getattr(index, '_embed_model').embed_dim, 8)
            self.assertIs(Settings.embed_model, marker_model)
            self.assertIs(Settings.transformations, marker_transformations)
            manager.reindex_file(self.file_request('a.md'))
            self.assertIs(Settings.embed_model, marker_model)
            self.assertIs(Settings.transformations, marker_transformations)
            self.assertEqual(manager.get_file_chunks(self.file_request('a.md'))['chunkCount'], 1)
            self.assertIs(Settings.embed_model, marker_model)
            self.assertIs(Settings.transformations, marker_transformations)

    def test_status_hashes_touched_unchanged_file_only_once(self):
        self.write_note('a.md')
        self.build()
        path = self.workspace / 'a.md'
        before = path.stat()
        os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns + 2_000_000_000))
        with patch.object(manager, 'file_sha256', wraps=manager.file_sha256) as hashed:
            snapshot = manager.build_status_snapshot(self.request)
        hashed.assert_called_once_with(path)
        self.assertEqual(snapshot['summary']['indexed'], 1)

    def test_pdf_reindex_keeps_both_pages_and_canonical_metadata(self):
        self.write_note('paper.pdf', 'reader input placeholder')
        with patch('llama_index.core.SimpleDirectoryReader') as reader:
            reader.return_value.load_data.side_effect = lambda: [
                Document(text=f'Page {page} content', metadata={'page_label': str(page), 'source': 'reader-value'})
                for page in (1, 2)
            ]
            self.build()
            result = manager.reindex_file(self.file_request('paper.pdf'))
        chunks = manager.get_file_chunks(self.file_request('paper.pdf'))
        self.assertEqual(result['chunks'], 2)
        self.assertEqual({chunk['metadata']['page_label'] for chunk in chunks['chunks']}, {'1', '2'})
        self.assertEqual({chunk['metadata']['source'] for chunk in chunks['chunks']}, {'paper.pdf'})

    def test_reindex_rejects_excluded_files_without_changes(self):
        self.write_note('a.md')
        self.build()
        before = self.stored_bytes()
        self.write_note('node_modules/ignored.md')
        with self.assertRaisesRegex(ValueError, '不支持|已排除'):
            manager.reindex_file(self.file_request('node_modules/ignored.md'))
        self.assertEqual(self.stored_bytes(), before)

    def test_legacy_absolute_metadata_matches_only_exact_workspace_file(self):
        self.write_note('a.md')
        self.write_note('nested/a.md')
        self.build()
        path = self.persist_dir / 'default__vector_store.json'
        data = json.loads(path.read_text())
        for node_id, metadata in data['metadata_dict'].items():
            metadata['source'] = str(self.workspace / metadata['source']).replace('/', '\\')
            data['text_id_to_ref_doc_id'][node_id] = 'legacy-doc-id'
        path.write_text(json.dumps(data), encoding='utf-8')
        manager.delete_file_index(self.file_request('a.md'))
        self.assertEqual(self.vector_sources(), [str(self.workspace / 'nested/a.md').replace('/', '\\')])
