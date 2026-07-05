import { buildGlobalApiUrl } from './apiConfig'

export type AuthScene = 'login' | 'register'

export type MailCodePayload = {
  email: string
  scene: AuthScene
}

export type RegisterEmailPayload = MailCodePayload & {
  password: string
  code: string
}

export type VerifyMailCodePayload = MailCodePayload & {
  code: string
}

export type LoginByPasswordPayload = {
  email: string
  password: string
}

export type LoginUser = {
  id: string
  username: string
  token: string
  role?: {
    id?: string
    name?: string
    key?: string
  }
}

export type LoomaApiResponse<T> = {
  code: number
  message?: string
  data?: T
}

const getAuthBaseUrl = () => buildGlobalApiUrl('/auth')

const parseResponse = async <T>(response: Response, fallbackMessage: string) => {
  let result: Partial<LoomaApiResponse<T>> | null = null
  try {
    result = (await response.json()) as LoomaApiResponse<T>
  } catch {
    result = null
  }

  if (!response.ok) {
    throw new Error(result?.message || `请求失败（HTTP ${response.status}）`)
  }
  if (!result || result.code !== 200) {
    throw new Error(result?.message || fallbackMessage)
  }
  return result.data as T
}

export const sendMailCode = async ({ email, scene }: MailCodePayload) => {
  const url = new URL(`${getAuthBaseUrl()}/mail-login`)
  url.searchParams.set('email', email.trim())
  url.searchParams.set('scene', scene)

  const response = await fetch(url.toString(), {
    method: 'POST',
    credentials: 'include',
  })

  await parseResponse<null>(response, '验证码发送失败，请稍后重试')
}

export const verifyMailCode = async ({ email, code, scene }: VerifyMailCodePayload) => {
  const url = new URL(`${getAuthBaseUrl()}/verify`)
  url.searchParams.set('scene', scene)

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      mail: email.trim(),
      code: code.trim(),
    }),
  })

  return parseResponse<LoginUser>(response, '登录失败，请稍后重试')
}

export const registerByEmail = async ({ email, password, code }: RegisterEmailPayload) => {
  const response = await fetch(`${getAuthBaseUrl()}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      email: email.trim(),
      password,
      code: code.trim(),
    }),
  })

  return parseResponse<LoginUser>(response, '注册失败，请稍后重试')
}

export const loginByPassword = async ({ email, password }: LoginByPasswordPayload) => {
  const response = await fetch(`${getAuthBaseUrl()}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    credentials: 'include',
    body: JSON.stringify({
      email: email.trim(),
      password,
    }),
  })

  return parseResponse<LoginUser>(response, '登录失败，请检查邮箱或密码')
}
