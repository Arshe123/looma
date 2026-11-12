import { expect, it } from 'vitest'
import { getEmbeddingDiscoveryTarget } from '../embeddingDiscovery'

it.each([
  ['https://api.openai.com/v1/', 'openai-embedding', 'https://api.openai.com/v1'],
  ['https://openrouter.ai/api/v1', 'openrouter-embedding', 'https://openrouter.ai/api/v1'],
  ['https://workspace-123.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'dashscope-embedding', 'https://workspace-123.cn-beijing.maas.aliyuncs.com'],
  ['https://workspace-123.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1', 'dashscope-embedding', 'https://workspace-123.ap-southeast-1.maas.aliyuncs.com'],
  ['https://workspace-123.cn-hongkong.maas.aliyuncs.com/api/v1', 'dashscope-embedding', 'https://workspace-123.cn-hongkong.maas.aliyuncs.com'],
  ['https://workspace-123.ap-northeast-1.maas.aliyuncs.com/api/v1/', 'dashscope-embedding', 'https://workspace-123.ap-northeast-1.maas.aliyuncs.com'],
  ['https://workspace-123.eu-central-1.maas.aliyuncs.com', 'dashscope-embedding', 'https://workspace-123.eu-central-1.maas.aliyuncs.com'],
  ['https://dashscope-us.aliyuncs.com/compatible-mode/v1', 'dashscope-embedding', 'https://dashscope-us.aliyuncs.com'],
])('只对明确的官方地址 %s 启用向量模型发现', (baseUrl, protocol, expectedUrl) => {
  expect(getEmbeddingDiscoveryTarget(baseUrl)).toEqual({ protocol, baseUrl: expectedUrl })
})

it.each([
  'https://dashscope.aliyuncs.com/compatible-mode/v1',
  'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
  'https://cn-hongkong.dashscope.aliyuncs.com/compatible-mode/v1',
  'https://workspace-123.us-east-1.maas.aliyuncs.com/api/v1',
  'https://ap-southeast-1.maas.aliyuncs.com/api/v1',
  'https://{WorkspaceId}.cn-hongkong.maas.aliyuncs.com/api/v1',
  'https://workspace-123.ap-southeast-1.maas.aliyuncs.com.evil.test/api/v1',
  'https://dashscope-us.aliyuncs.com.evil.test/api/v1',
  'https://dashscope-us.aliyuncs.com/unrecognized',
  'https://api.deepseek.com/v1',
  'https://compatible.example.test/v1',
  'https://api.openai.com.evil.test/v1',
  'https://evil.cn-beijing.maas.aliyuncs.com.evil.test',
  'https://api.openai.com/v1/unrecognized',
  'https://user:password@api.openai.com/v1',
  'https://api.openai.com/v1?key=secret',
  'https://api.openai.com/v1#fragment',
  'https://api.openai.com:8443/v1',
  'http://api.openai.com/v1',
  'invalid',
])('无法明确查询的地址 %s 不猜测接口', baseUrl => {
  expect(getEmbeddingDiscoveryTarget(baseUrl)).toBeNull()
})
