# Looma 用户邮箱注册/登录接口

## 页面/入口

- 入口：`src/renderer/components/Sidebar.vue` 底部用户图标
- 弹窗：`src/renderer/components/auth/AuthModal.vue`
- 前端服务：`src/renderer/services/authApi.ts`

## 当前接入范围

本次接入：

1. 邮箱 + 密码登录
2. 邮箱验证码登录
3. 邮箱 + 密码 + 邮箱验证码注册

注册必须保留密码；验证码只用于验证邮箱归属，不替代密码。

## 后端接口

### 1. 发送邮箱验证码

- 方法：`POST`
- 地址：`http://localhost:8080/globalApi/auth/mail-login`
- 鉴权：不需要登录，Sa-token 拦截器已放行 `/globalApi/auth/mail-login`
- Query 参数：
  - `email`：邮箱地址，必填
  - `scene`：场景，取值 `login` 或 `register`，默认 `login`

登录验证码示例：

```http
POST /globalApi/auth/mail-login?email=user@example.com&scene=login
```

注册验证码示例：

```http
POST /globalApi/auth/mail-login?email=user@example.com&scene=register
```

后端规则：

- `scene=login`：邮箱必须已注册，否则返回 `该邮箱尚未注册，请先注册`。
- `scene=register`：邮箱必须未注册，否则返回 `该邮箱已注册，请直接登录`。
- 验证码缓存 key 按场景隔离：`looma:auth:mail-code:{scene}:{email}`。
- 验证码有效期 5 分钟。

### 2. 邮箱验证码登录

- 方法：`POST`
- 地址：`http://localhost:8080/globalApi/auth/verify?scene=login`
- 鉴权：不需要登录，Sa-token 拦截器已放行 `/globalApi/auth/verify`
- Content-Type：`application/json`

请求体：

```json
{
  "mail": "user@example.com",
  "code": "123456"
}
```

成功后后端调用 `StpUtil.login(userId)` 并返回 `LoginVO`。

### 3. 邮箱密码登录

- 方法：`POST`
- 地址：`http://localhost:8080/globalApi/auth/login`
- 鉴权：不需要登录
- Content-Type：`application/json`

请求体：

```json
{
  "email": "user@example.com",
  "password": "用户密码"
}
```

后端规则：

- 如果传 `email`，按邮箱查询用户并校验密码。
- 如果不传 `email`，保留原有按 `username` 登录的兼容逻辑。

### 4. 邮箱注册

- 方法：`POST`
- 地址：`http://localhost:8080/globalApi/auth/register`
- 鉴权：不需要登录
- Content-Type：`application/json`

请求体：

```json
{
  "email": "user@example.com",
  "password": "用户密码",
  "code": "123456"
}
```

后端规则：

- 邮箱格式必须合法。
- 密码长度不能少于 6 位。
- 邮箱必须未注册。
- `code` 必须匹配 `scene=register` 发送的邮箱验证码。
- 注册用户默认角色为普通用户：`350729685119864832`。
- 用户名由后端根据邮箱自动生成；后续如果要用户自定义用户名，可以在注册体中增加 `username`。
- 注册成功后自动调用 `StpUtil.login(userId)` 并返回 `LoginVO`。

成功响应示例：

```json
{
  "code": 200,
  "message": "成功",
  "data": {
    "id": "1451620309294645248",
    "username": "u1abcxyz",
    "role": {
      "id": "350729685119864832",
      "name": "普通用户",
      "key": "user"
    },
    "token": "satoken-value"
  }
}
```

## 数据库存储

`easy_user.email` 用于唯一识别邮箱账号。初始化 SQL 已补充邮箱唯一索引：

```sql
alter table easy_user
    add unique key easy_user_email_uindex (email);
```

如果旧库已经存在重复邮箱，需要先清理重复数据再加唯一索引。

## 前端保存

登录/注册成功后，前端保存：

- `localStorage['looma:user']`：后端返回的登录用户信息（含 token）
- `localStorage['looma:userEmail']`：当前邮箱，用于用户菜单展示
