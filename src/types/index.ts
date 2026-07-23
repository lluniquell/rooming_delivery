export type Role = 'admin' | 'driver'
export type DeliveryStatus = 'pending' | 'done' | 'failed'
// 'driver' = 모바일 배송원 앱 접근 (다른 값들과 배타적). role 컬럼은 DB 호환을 위해 남아있지만
// 앱 코드에서는 더 이상 읽지 않음 — permissions만으로 라우팅/권한을 전부 판단
export type Permission = 'admin' | 'orders' | 'schedule' | 'delivery' | 'soum' | 'driver'

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

export interface DeliveryItem {
  product_no: string
  product_name: string
  quantity: number
  option_info?: string
}

export interface Delivery {
  id: string
  cafe24_order_no: string
  customer_name: string
  address: string
  items: DeliveryItem[]
  driver_id: string | null
  sort_order: number | null
  status: DeliveryStatus
  scheduled_date: string
  completed_at: string | null
  memo: string | null
  invoice_no: string | null
  created_at: string
  driver?: Driver
}

export interface DeliveryPhoto {
  id: string
  delivery_id: string
  storage_path: string
  created_at: string
}
