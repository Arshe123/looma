export interface Result<T = void> {
  success: boolean;
  data?: T;
  error?: string;
  errorCode?: string;
}
