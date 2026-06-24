export type Role = 'admin' | 'driver'
export type DeliveryStatus = 'pending' | 'done' | 'failed'

export interface Driver {
  id: string
  name: string
  email: string
  role: Role
  is_active: boolean
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
