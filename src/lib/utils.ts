import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

// 拼接tailwindCSS类名
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
