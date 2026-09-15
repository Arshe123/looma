import unittest

from main import app


class ApiSurfaceTest(unittest.TestCase):
    def test_only_desktop_service_routes_are_exposed(self):
        routes = {(method, path) for route in app.routes
                  for path in [getattr(route, 'path', '')]
                  for method in getattr(route, 'methods', ())
                  if path.startswith(('/rag/', '/agent/')) or path == '/health'}
        self.assertEqual(routes, {
            ('GET', '/health'),
            ('POST', '/agent/summarize'),
            ('POST', '/agent/run/stream'),
            ('POST', '/rag/index/status'),
            ('POST', '/rag/index/build/stream'),
            ('POST', '/rag/index/file/chunks'),
            ('POST', '/rag/index/file/reindex'),
            ('DELETE', '/rag/index/file'),
            ('DELETE', '/rag/index'),
        })
