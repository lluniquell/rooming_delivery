export type Role = 'admin' | 'driver'
// 'driver' = 모바일 배송원 앱 접근 (다른 값들과 배타적). role 컬럼은 DB 호환을 위해 남아있지만
// 앱 코드에서는 더 이상 읽지 않음 — permissions만으로 라우팅/권한을 전부 판단
export type Permission = 'admin' | 'orders' | 'schedule' | 'logistics' | 'soum' | 'showroom' | 'driver'

export interface Driver {
  id: string
  name: string
  email: string
  role: Role
  is_active: boolean
  is_superadmin: boolean
  permissions: Permission[]
  created_at: string
}
