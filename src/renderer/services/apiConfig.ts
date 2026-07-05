// 后端 HTTP 接口统一配置
// 直连后端的服务（authApi、feedbackApi 等）统一从这里取地址，避免散落硬编码。
//
// 覆盖方式：在项目根目录 .env / .env.local 中设置 VITE_API_BASE_URL，例如
//   VITE_API_BASE_URL=http://192.168.1.10:8080
// 未设置时回退到本地默认地址。

/** 后端默认地址（本地开发） */
const DEFAULT_API_HOST = 'http://localhost:8080'

/** 全局接口前缀（对应后端 application.yml 的 prefix: /globalApi） */
const GLOBAL_API_PREFIX = '/globalApi'

/** 后端主机地址（已去除结尾斜杠） */
export const API_HOST = (import.meta.env.VITE_API_BASE_URL || DEFAULT_API_HOST).replace(/\/+$/, '')

/** 全局接口基础地址：<host>/globalApi */
export const GLOBAL_API_BASE = `${API_HOST}${GLOBAL_API_PREFIX}`

/**
 * 拼接一个 /globalApi 下的接口地址
 * @example buildGlobalApiUrl('/auth')  // http://localhost:8080/globalApi/auth
 */
export const buildGlobalApiUrl = (path: string) =>
  `${GLOBAL_API_BASE}${path.startsWith('/') ? path : `/${path}`}`

/** 登录用户信息在 localStorage 中的键（与 Sidebar.vue 保持一致） */
export const USER_STORAGE_KEY = 'looma:user'

/** Sa-token 鉴权头名称（对应后端 sa-token.token-name；后端 isReadCookie=false，仅从该头读取） */
export const AUTH_TOKEN_HEADER = 'easyToken'

/** 读取登录时返回并保存的 token；未登录或解析失败返回空字符串 */
export const getAuthToken = (): string => {
  try {
    const raw = localStorage.getItem(USER_STORAGE_KEY)
    if (!raw) return ''
    const user = JSON.parse(raw) as { token?: string } | null
    return user?.token ?? ''
  } catch {
    return ''
  }
}

/**
 * 在给定请求头基础上附加鉴权头（easyToken）。
 * 仅在已登录（存在 token）时添加，未登录时原样返回。
 */
export const withAuthHeaders = (headers: Record<string, string> = {}): Record<string, string> => {
  const token = getAuthToken()
  return token ? { ...headers, [AUTH_TOKEN_HEADER]: token } : { ...headers }
}
